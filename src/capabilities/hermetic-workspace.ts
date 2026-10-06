import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ActionRequest,
  ActionResult,
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityScore,
  ProviderReconciliationRequest,
  ProviderReconciliationResult
} from '../core/types.ts';
import { canonicalJson } from '../core/action-identity.ts';
import { readDurableStateText, writeDurableStateText } from '../core/durable-state.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveSupportedGitExecutable } from '../core/trusted-executable.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.98,
  latency: 0.72,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.98,
  informationQuality: 0.99,
  interactionCost: 0.04
};

const STATE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'HERMETIC_WORKSPACE_STATE_CORRUPT',
  invalidMessage: 'Hermetic workspace state is invalid.'
} as const;
const NULL_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT_PREFIX = [
  '--no-pager',
  '--no-lazy-fetch',
  '-c', 'core.fsmonitor=false',
  '-c', 'submodule.recurse=false',
  '-c', 'core.hooksPath=' + NULL_CONFIG
];
const LOCK_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'gradle.lockfile'
]);
const MAX_LOCK_FILES = 1000;
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_LOCK_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_VISITS = 100_000;
const MAX_SCAN_DEPTH = 5;

export type HermeticWorkspaceState = 'PROVISIONING' | 'READY' | 'RELEASING' | 'RELEASED';

export interface HermeticDependencyLock {
  path: string;
  sha256: string;
  bytes: number;
}

export interface HermeticWorkspaceManifest {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sourceRoot: string;
  sourceHead: string;
  worktreeRoot: string;
  dependencyLocks: HermeticDependencyLock[];
  createdAt: string;
}

interface HermeticWorkspaceRecord {
  schemaVersion: 1;
  state: HermeticWorkspaceState;
  manifest: HermeticWorkspaceManifest;
  updatedAt: string;
}

type GitOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export class HermeticWorkspaceProvider implements CapabilityProvider {
  readonly name = 'workspace.hermetic.git';
  #scope: PathScope;
  #stateDir: string;
  #ownedRoot: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(options: {
    allowedRoots: string[];
    stateDir: string;
    windowsPathLeaseExecutable?: string;
    clock?: () => Date;
  }) {
    if (!options.stateDir) throw new OperatorError('HERMETIC_WORKSPACE_STATE_DIR_REQUIRED', 'stateDir is required.');
    this.#scope = new PathScope(options.allowedRoots, {
      windowsPathLeaseExecutable: options.windowsPathLeaseExecutable
    });
    this.#stateDir = path.resolve(options.stateDir);
    this.#ownedRoot = path.join(this.#stateDir, 'hermetic-workspaces');
    this.#clock = options.clock ?? (() => new Date());
  }

  supports(action: ActionRequest): boolean {
    return [
      'workspace.hermetic.provision',
      'workspace.hermetic.inspect',
      'workspace.hermetic.release'
    ].includes(action.capability);
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    return await this.#enqueue(async () => {
      const started = performance.now();
      try {
        if (action.capability === 'workspace.hermetic.provision') {
          return await this.#provision(action, context, started);
        }
        if (action.capability === 'workspace.hermetic.inspect') {
          return await this.#inspect(action, started);
        }
        if (action.capability === 'workspace.hermetic.release') {
          return await this.#release(action, context, started);
        }
        throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
      } catch (error) {
        const op = error instanceof OperatorError
          ? error
          : new OperatorError('HERMETIC_WORKSPACE_ERROR', error instanceof Error ? error.message : String(error));
        return {
          ok: false,
          capability: action.capability,
          provider: this.name,
          evidence: [evidence('hermetic_workspace', 'fail', op.message, { code: op.code })],
          error: {
            code: op.code,
            message: op.message,
            retryable: op.retryable,
            sideEffectState: action.capability === 'workspace.hermetic.inspect' ? 'none' : 'uncertain',
            executionPhase: 'pre_dispatch'
          },
          durationMs: Math.round(performance.now() - started)
        };
      }
    });
  }

  async reconcile(
    request: ProviderReconciliationRequest,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    return await this.#enqueue(async () => {
      try {
        if (request.action.capability === 'workspace.hermetic.provision') {
          const sessionId = sessionIdFrom(request.action);
          const record = await this.#readRecord(sessionId);
          if (!record) {
            return {
              status: 'not_applied',
              evidence: [evidence('hermetic_workspace_reconciliation', 'info', 'No durable workspace record exists.')]
            };
          }
          if (record.state === 'RELEASED') {
            return {
              status: 'not_applied',
              evidence: [evidence('hermetic_workspace_reconciliation', 'info', 'Workspace record is already released.')]
            };
          }
          const inspected = await this.#inspectManifest(record.manifest, context.signal);
          if (!inspected.ok) {
            return {
              status: 'uncertain',
              evidence: [evidence(
                'hermetic_workspace_reconciliation',
                'info',
                'Hermetic worktree does not match its durable manifest.',
                { code: inspected.code }
              )]
            };
          }
          if (record.state !== 'READY') {
            const ready = { ...record, state: 'READY' as const, updatedAt: this.#now() };
            await this.#writeRecord(ready);
          }
          const result = workspaceSuccess(request.action, record.manifest, 'provision', 0, true);
          return { status: 'completed', result, evidence: result.evidence };
        }

        if (request.action.capability === 'workspace.hermetic.release') {
          const sessionId = sessionIdFrom(request.action);
          const record = await this.#readRecord(sessionId);
          if (!record) {
            return {
              status: 'not_applied',
              evidence: [evidence('hermetic_workspace_reconciliation', 'info', 'No workspace record exists.')]
            };
          }
          const rootState = await inspectOwnedDirectory(record.manifest.worktreeRoot, this.#ownedRoot);
          if (record.state === 'RELEASED' && rootState === 'missing') {
            const result = workspaceSuccess(request.action, record.manifest, 'release', 0, true);
            return { status: 'completed', result, evidence: result.evidence };
          }
          if (rootState === 'missing') {
            const released = { ...record, state: 'RELEASED' as const, updatedAt: this.#now() };
            await this.#writeRecord(released);
            const result = workspaceSuccess(request.action, record.manifest, 'release', 0, true);
            return { status: 'completed', result, evidence: result.evidence };
          }
          return {
            status: 'not_applied',
            evidence: [evidence('hermetic_workspace_reconciliation', 'info', 'Hermetic worktree still exists.')]
          };
        }

        return {
          status: 'uncertain',
          evidence: [evidence('hermetic_workspace_reconciliation', 'info', 'Inspect actions do not require mutation reconciliation.')]
        };
      } catch (error) {
        return {
          status: 'uncertain',
          evidence: [evidence(
            'hermetic_workspace_reconciliation',
            'info',
            'Hermetic workspace state could not be reconciled safely.',
            { code: error instanceof OperatorError ? error.code : 'HERMETIC_WORKSPACE_RECONCILIATION_FAILED' }
          )]
        };
      }
    });
  }

  async #provision(
    action: ActionRequest,
    context: CapabilityExecutionContext,
    started: number
  ): Promise<ActionResult> {
    if (action.risk !== 'write') {
      throw new OperatorError('HERMETIC_WORKSPACE_RISK_MISMATCH', 'Provision requires write risk.');
    }
    const sessionId = sessionIdFrom(action);
    const sourceInput = requiredString(action.input.sourceRoot, 'sourceRoot');
    const expectedHead = gitObjectId(action.input.expectedHead, 'expectedHead');

    const existing = await this.#readRecord(sessionId);
    if (existing) {
      if (existing.manifest.sourceHead !== expectedHead) {
        throw new OperatorError('HERMETIC_WORKSPACE_SESSION_CONFLICT', 'Session id is already bound to another source revision.');
      }
      const sourceRoot = await this.#resolveSourceRoot(sourceInput);
      if (canonicalPath(existing.manifest.sourceRoot) !== canonicalPath(sourceRoot)) {
        throw new OperatorError('HERMETIC_WORKSPACE_SESSION_CONFLICT', 'Session id is already bound to another source root.');
      }
      const checked = await this.#inspectManifest(existing.manifest, context.signal);
      if (!checked.ok) {
        throw new OperatorError('HERMETIC_WORKSPACE_RECONCILIATION_REQUIRED', 'Existing session workspace does not match its durable manifest.');
      }
      return workspaceSuccess(action, existing.manifest, 'provision', started, true);
    }

    const sourceRoot = await this.#resolveSourceRoot(sourceInput);
    await this.#prepareOwnedRoot(sourceRoot);
    await assertNoRepoLocalContentFilters(sourceRoot, context.signal);

    const actualHead = (await runGit(sourceRoot, ['rev-parse', '--verify', 'HEAD'], context.signal)).stdout.trim().toLowerCase();
    if (actualHead !== expectedHead) {
      throw new OperatorError('HERMETIC_WORKSPACE_HEAD_CHANGED', 'Source repository HEAD does not match expectedHead.', {
        retryable: true,
        details: { expectedHead, actualHead }
      });
    }

    const worktreeRoot = path.join(this.#ownedRoot, sessionDigest(sessionId));
    const rootState = await inspectOwnedDirectory(worktreeRoot, this.#ownedRoot);
    if (rootState !== 'missing') {
      throw new OperatorError('HERMETIC_WORKSPACE_DESTINATION_EXISTS', 'Owned hermetic workspace destination already exists.');
    }

    const createdAt = this.#now();
    const provisional = createManifest({
      sessionId,
      sourceRoot,
      sourceHead: expectedHead,
      worktreeRoot,
      dependencyLocks: [],
      createdAt
    });
    await this.#writeRecord({
      schemaVersion: 1,
      state: 'PROVISIONING',
      manifest: provisional,
      updatedAt: createdAt
    });

    try {
      await runGit(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, expectedHead], context.signal);
      const realWorktree = await fs.realpath(worktreeRoot);
      if (canonicalPath(realWorktree) !== canonicalPath(worktreeRoot)) {
        throw new OperatorError('HERMETIC_WORKSPACE_PATH_CHANGED', 'Created worktree resolves outside its deterministic owned path.');
      }
      const locks = await scanDependencyLocks(realWorktree);
      const manifest = createManifest({
        sessionId,
        sourceRoot,
        sourceHead: expectedHead,
        worktreeRoot: realWorktree,
        dependencyLocks: locks,
        createdAt
      });
      const checked = await this.#inspectManifest(manifest, context.signal);
      if (!checked.ok) throw new OperatorError(checked.code, checked.message);

      await this.#writeRecord({
        schemaVersion: 1,
        state: 'READY',
        manifest,
        updatedAt: this.#now()
      });
      return workspaceSuccess(action, manifest, 'provision', started, false);
    } catch (error) {
      await safeRemoveFailedWorktree(sourceRoot, worktreeRoot, context.signal);
      throw error;
    }
  }

  async #inspect(action: ActionRequest, started: number): Promise<ActionResult> {
    if (action.risk !== 'read') {
      throw new OperatorError('HERMETIC_WORKSPACE_RISK_MISMATCH', 'Inspect requires read risk.');
    }
    const sessionId = sessionIdFrom(action);
    const record = await this.#readRecord(sessionId);
    if (!record) throw new OperatorError('HERMETIC_WORKSPACE_NOT_FOUND', 'Hermetic workspace session was not found.');
    const inspected = record.state === 'RELEASED'
      ? { ok: false as const, code: 'HERMETIC_WORKSPACE_RELEASED', message: 'Workspace is released.' }
      : await this.#inspectManifest(record.manifest);
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: {
        state: record.state,
        manifest: publicManifest(record.manifest),
        healthy: inspected.ok,
        ...(inspected.ok ? {} : { healthCode: inspected.code })
      },
      evidence: [evidence(
        'hermetic_workspace_inspect',
        inspected.ok || record.state === 'RELEASED' ? 'pass' : 'fail',
        inspected.ok ? 'Hermetic workspace matches its immutable source and dependency-lock manifest.' : inspected.message,
        { sessionId, state: record.state }
      )],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #release(
    action: ActionRequest,
    context: CapabilityExecutionContext,
    started: number
  ): Promise<ActionResult> {
    if (action.risk !== 'destructive') {
      throw new OperatorError('HERMETIC_WORKSPACE_RISK_MISMATCH', 'Release requires destructive risk.');
    }
    const sessionId = sessionIdFrom(action);
    const expectedManifestId = digestField(action.input.expectedManifestId, 'expectedManifestId');
    const record = await this.#readRecord(sessionId);
    if (!record) throw new OperatorError('HERMETIC_WORKSPACE_NOT_FOUND', 'Hermetic workspace session was not found.');
    if (record.manifest.id !== expectedManifestId) {
      throw new OperatorError('HERMETIC_WORKSPACE_MANIFEST_CHANGED', 'Release precondition does not match current manifest.');
    }
    if (record.state === 'RELEASED') return workspaceSuccess(action, record.manifest, 'release', started, true);

    const releasing = { ...record, state: 'RELEASING' as const, updatedAt: this.#now() };
    await this.#writeRecord(releasing);
    const rootState = await inspectOwnedDirectory(record.manifest.worktreeRoot, this.#ownedRoot);
    if (rootState === 'unsafe') {
      throw new OperatorError('HERMETIC_WORKSPACE_RELEASE_UNSAFE', 'Owned worktree path has unsafe topology.');
    }
    if (rootState === 'directory') {
      await runGit(record.manifest.sourceRoot, ['worktree', 'remove', '--force', record.manifest.worktreeRoot], context.signal);
    }
    await runGit(record.manifest.sourceRoot, ['worktree', 'prune', '--expire', 'now'], context.signal);
    const after = await inspectOwnedDirectory(record.manifest.worktreeRoot, this.#ownedRoot);
    if (after !== 'missing') {
      throw new OperatorError('HERMETIC_WORKSPACE_RELEASE_POSTCONDITION_FAILED', 'Hermetic worktree still exists after release.');
    }
    const released = { ...record, state: 'RELEASED' as const, updatedAt: this.#now() };
    await this.#writeRecord(released);
    return workspaceSuccess(action, released.manifest, 'release', started, false);
  }

  async #inspectManifest(
    manifest: HermeticWorkspaceManifest,
    signal?: AbortSignal
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const valid = validateManifest(manifest);
    const state = await inspectOwnedDirectory(valid.worktreeRoot, this.#ownedRoot);
    if (state !== 'directory') {
      return { ok: false, code: 'HERMETIC_WORKSPACE_MISSING', message: 'Hermetic worktree is missing or unsafe.' };
    }
    const head = (await runGit(valid.worktreeRoot, ['rev-parse', '--verify', 'HEAD'], signal)).stdout.trim().toLowerCase();
    if (head !== valid.sourceHead) {
      return { ok: false, code: 'HERMETIC_WORKSPACE_HEAD_DRIFT', message: 'Hermetic worktree HEAD differs from its source revision.' };
    }
    const locks = await scanDependencyLocks(valid.worktreeRoot);
    if (canonicalJson(locks) !== canonicalJson(valid.dependencyLocks)) {
      return { ok: false, code: 'HERMETIC_WORKSPACE_LOCK_DRIFT', message: 'Dependency lock manifest changed.' };
    }
    return { ok: true };
  }

  async #resolveSourceRoot(input: string): Promise<string> {
    return await this.#scope.withExisting(input, async (resolved) => {
      const stat = await fs.lstat(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new OperatorError('HERMETIC_WORKSPACE_SOURCE_INVALID', 'sourceRoot must be a real directory.');
      }
      const top = (await runGit(resolved, ['rev-parse', '--show-toplevel'])).stdout.trim();
      const canonical = await this.#scope.resolveExisting(top);
      if (canonicalPath(canonical) !== canonicalPath(resolved)) {
        throw new OperatorError('HERMETIC_WORKSPACE_SOURCE_NOT_ROOT', 'sourceRoot must be the Git repository root.');
      }
      return canonical;
    });
  }

  async #prepareOwnedRoot(sourceRoot: string): Promise<void> {
    if (inside(this.#ownedRoot, sourceRoot) || inside(sourceRoot, this.#ownedRoot)) {
      throw new OperatorError('HERMETIC_WORKSPACE_ROOT_OVERLAP', 'Mecord-owned worktrees may not overlap the source repository.');
    }
    await fs.mkdir(this.#ownedRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#ownedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OperatorError('HERMETIC_WORKSPACE_OWNED_ROOT_UNSAFE', 'Owned worktree root has unsafe topology.');
    }
    const real = await fs.realpath(this.#ownedRoot);
    if (canonicalPath(real) !== canonicalPath(this.#ownedRoot)) {
      throw new OperatorError('HERMETIC_WORKSPACE_OWNED_ROOT_UNSAFE', 'Owned worktree root resolves through an unexpected alias.');
    }
  }

  async #readRecord(sessionId: string): Promise<HermeticWorkspaceRecord | undefined> {
    try {
      return validateRecord(JSON.parse(await readDurableStateText(this.#recordPath(sessionId), STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) throw new OperatorError('HERMETIC_WORKSPACE_STATE_CORRUPT', 'Workspace record contains invalid JSON.');
      throw error;
    }
  }

  async #writeRecord(record: HermeticWorkspaceRecord): Promise<void> {
    const valid = validateRecord(record);
    await writeDurableStateText(this.#recordPath(valid.manifest.sessionId), JSON.stringify(valid), STATE_OPTIONS);
  }

  #recordPath(sessionId: string): string {
    return path.join(this.#stateDir, 'hermetic-workspace-state', sessionDigest(sessionId) + '.json');
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createManifest(input: Omit<HermeticWorkspaceManifest, 'schemaVersion' | 'id'>): HermeticWorkspaceManifest {
  const identity = {
    schemaVersion: 1 as const,
    sessionId: sessionIdValue(input.sessionId),
    sourceRoot: absolutePath(input.sourceRoot, 'sourceRoot'),
    sourceHead: gitObjectId(input.sourceHead, 'sourceHead'),
    worktreeRoot: absolutePath(input.worktreeRoot, 'worktreeRoot'),
    dependencyLocks: normalizeLocks(input.dependencyLocks),
    createdAt: canonicalIso(input.createdAt, 'createdAt')
  };
  const id = crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
  return { ...identity, id };
}

function validateManifest(input: unknown): HermeticWorkspaceManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Workspace manifest is invalid.');
  const raw = input as HermeticWorkspaceManifest;
  const normalized = createManifest({
    sessionId: raw.sessionId,
    sourceRoot: raw.sourceRoot,
    sourceHead: raw.sourceHead,
    worktreeRoot: raw.worktreeRoot,
    dependencyLocks: raw.dependencyLocks,
    createdAt: raw.createdAt
  });
  if (raw.schemaVersion !== 1 || raw.id !== normalized.id) throw corrupt('Workspace manifest identity is invalid.');
  return normalized;
}

function validateRecord(input: unknown): HermeticWorkspaceRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Workspace record is invalid.');
  const raw = input as HermeticWorkspaceRecord;
  if (raw.schemaVersion !== 1 || !['PROVISIONING', 'READY', 'RELEASING', 'RELEASED'].includes(raw.state)) {
    throw corrupt('Workspace record shape is invalid.');
  }
  const manifest = validateManifest(raw.manifest);
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(manifest.createdAt)) throw corrupt('Workspace record timestamp precedes creation.');
  return { schemaVersion: 1, state: raw.state, manifest, updatedAt };
}

async function scanDependencyLocks(root: string): Promise<HermeticDependencyLock[]> {
  const output: HermeticDependencyLock[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visits = 0;
  let totalBytes = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visits += 1;
      if (visits > MAX_SCAN_VISITS) throw new OperatorError('HERMETIC_WORKSPACE_SCAN_LIMIT', 'Dependency lock scan exceeded visit budget.');
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH && entry.name !== '.git' && entry.name !== 'node_modules') {
          queue.push({ dir: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !LOCK_NAMES.has(entry.name)) continue;
      if (output.length >= MAX_LOCK_FILES) throw new OperatorError('HERMETIC_WORKSPACE_LOCK_LIMIT', 'Too many dependency lock files.');
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_LOCK_BYTES) {
        throw new OperatorError('HERMETIC_WORKSPACE_LOCK_UNSAFE', 'Dependency lock file has unsafe topology or size.');
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_LOCK_BYTES) throw new OperatorError('HERMETIC_WORKSPACE_LOCK_LIMIT', 'Dependency lock files exceed total byte budget.');
      const bytes = await fs.readFile(absolute);
      output.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        sha256: sha256(bytes),
        bytes: bytes.byteLength
      });
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function assertNoRepoLocalContentFilters(root: string, signal?: AbortSignal): Promise<void> {
  const result = await runGit(root, ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], signal, true);
  if (result.code !== 0 && result.code !== 1) {
    throw new OperatorError('HERMETIC_WORKSPACE_FILTER_INSPECTION_FAILED', 'Unable to inspect Git content filters.');
  }
  if (result.stdout.trim()) {
    throw new OperatorError('HERMETIC_WORKSPACE_CONTENT_FILTER_DENIED', 'Repository content filters are denied for hermetic worktree checkout.');
  }
}

async function safeRemoveFailedWorktree(sourceRoot: string, worktreeRoot: string, signal?: AbortSignal): Promise<void> {
  try {
    const state = await inspectOwnedDirectory(worktreeRoot, path.dirname(worktreeRoot));
    if (state === 'directory') {
      await runGit(sourceRoot, ['worktree', 'remove', '--force', worktreeRoot], signal, true);
    }
    await runGit(sourceRoot, ['worktree', 'prune', '--expire', 'now'], signal, true);
  } catch {}
}

async function inspectOwnedDirectory(candidate: string, ownedRoot: string): Promise<'missing' | 'directory' | 'unsafe'> {
  if (!inside(candidate, ownedRoot)) return 'unsafe';
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
    const real = await fs.realpath(candidate);
    return canonicalPath(real) === canonicalPath(candidate) ? 'directory' : 'unsafe';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowNonZero = false
): Promise<GitOutput> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperatorError('EXECUTION_ABORTED', 'Git operation was cancelled.'));
      return;
    }
    const env = gitEnvironment();
    const executable = resolveSupportedGitExecutable(env);
    const child = spawn(executable, [...SAFE_GIT_PREFIX, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 4 * 1024 * 1024;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= maxBytes) return;
      const part = chunk.subarray(0, maxBytes - bytes);
      bucket.push(part);
      bytes += part.byteLength;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, 60_000);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'Git operation was cancelled.'));
        return;
      }
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (result.code !== 0 && !allowNonZero) {
        reject(new OperatorError('HERMETIC_WORKSPACE_GIT_FAILED', result.stderr.trim().slice(0, 1600) || 'Git operation failed.'));
        return;
      }
      resolve(result);
    });
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: NULL_CONFIG,
    GIT_CONFIG_SYSTEM: NULL_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: ''
  };
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'USER', 'USERNAME', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function workspaceSuccess(
  action: ActionRequest,
  manifest: HermeticWorkspaceManifest,
  operation: 'provision' | 'release',
  started: number,
  reconciled: boolean
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'workspace.hermetic.git',
    output: {
      operation,
      manifest: publicManifest(manifest),
      reconciled
    },
    evidence: [
      evidence(
        'hermetic_workspace',
        'pass',
        operation === 'provision'
          ? 'Detached worktree is bound to the exact source commit and dependency-lock manifest.'
          : 'Mecord-owned hermetic worktree was released.',
        { sessionId: manifest.sessionId, manifestId: manifest.id, sourceHead: manifest.sourceHead }
      )
    ],
    durationMs: started === 0 ? 0 : Math.round(performance.now() - started)
  };
}

function publicManifest(manifest: HermeticWorkspaceManifest): HermeticWorkspaceManifest {
  return structuredClone(manifest);
}

function normalizeLocks(input: unknown): HermeticDependencyLock[] {
  if (!Array.isArray(input) || input.length > MAX_LOCK_FILES) throw corrupt('Dependency lock list is invalid.');
  const seen = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw corrupt('Dependency lock entry is invalid.');
    const raw = item as Record<string, unknown>;
    const relative = relativePath(raw.path, 'dependency lock path');
    if (seen.has(relative)) throw corrupt('Dependency lock paths must be unique.');
    seen.add(relative);
    const bytes = Number(raw.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_LOCK_BYTES) throw corrupt('Dependency lock byte count is invalid.');
    return { path: relative, sha256: digestField(raw.sha256, 'dependency lock sha256'), bytes };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function sessionIdFrom(action: ActionRequest): string {
  return sessionIdValue(action.input.sessionId);
}

function sessionIdValue(input: unknown): string {
  const value = requiredString(input, 'sessionId');
  if (!/^[A-Za-z0-9._:@-]{1,256}$/.test(value)) throw new OperatorError('HERMETIC_WORKSPACE_SESSION_INVALID', 'sessionId is invalid.');
  return value;
}

function sessionDigest(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > 32 * 1024 || input.includes('\0')) {
    throw new OperatorError('HERMETIC_WORKSPACE_INPUT_INVALID', label + ' is invalid.');
  }
  return input;
}

function relativePath(input: unknown, label: string): string {
  const value = requiredString(input, label);
  if (value.includes('\\')) throw corrupt(label + ' must use forward slashes.');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw corrupt(label + ' escapes workspace root.');
  return normalized;
}

function absolutePath(input: unknown, label: string): string {
  const value = requiredString(input, label);
  if (!path.isAbsolute(value)) throw corrupt(label + ' must be absolute.');
  return path.resolve(value);
}

function gitObjectId(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new OperatorError('HERMETIC_WORKSPACE_REVISION_INVALID', label + ' must be a full Git object id.');
  return value;
}

function digestField(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('HERMETIC_WORKSPACE_INPUT_INVALID', label + ' must be SHA-256.');
  return value;
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw corrupt(label + ' must be canonical ISO.');
  return value;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function corrupt(message: string): OperatorError {
  return new OperatorError('HERMETIC_WORKSPACE_STATE_CORRUPT', message);
}
