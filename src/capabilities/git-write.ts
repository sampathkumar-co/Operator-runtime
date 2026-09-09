import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { GitCheckpointProvider } from './git-checkpoint.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.94,
  determinism: 0.99,
  security: 0.97,
  reversibility: 0.97,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const SAFE_GIT_PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false', '--literal-pathspecs'];
const MAX_OUTPUT_BYTES = 1024 * 1024;

type RepoState = {
  root: string;
  head?: string;
  indexTree: string;
  worktreeTree: string;
  fingerprint: string;
};

type GitOutput = { code: number; stdout: string; stderr: string };

export class GitWriteProvider implements CapabilityProvider {
  readonly name = 'git.write.native';
  #checkpoint: GitCheckpointProvider;

  constructor(options: { allowedRoots: string[] }) {
    this.#checkpoint = new GitCheckpointProvider(options);
  }

  supports(action: ActionRequest): boolean { return action.capability === 'git.write'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      const operation = String(action.input.operation ?? '');
      if (!['stage', 'unstage', 'commit'].includes(operation)) {
        throw new OperatorError('INVALID_GIT_WRITE_OPERATION', 'operation must be stage, unstage, or commit.');
      }
      const cwd = String(action.input.cwd ?? '');
      const expectedCurrentFingerprint = String(action.input.expectedCurrentFingerprint ?? '');
      if (!/^[0-9a-f]{64}$/i.test(expectedCurrentFingerprint)) {
        throw new OperatorError('GIT_WRITE_FINGERPRINT_REQUIRED', 'expectedCurrentFingerprint from git.checkpoint inspect is required.');
      }

      const before = await this.#inspectState(cwd);
      if (before.fingerprint !== expectedCurrentFingerprint) {
        throw new OperatorError('GIT_WRITE_STATE_CHANGED', 'Repository state changed after the supplied write precondition was captured.', {
          retryable: true,
          details: { expectedCurrentFingerprint, actualCurrentFingerprint: before.fingerprint }
        });
      }

      const checkpointResult = await this.#checkpoint.execute({
        id: `${action.id}:checkpoint`,
        capability: 'git.checkpoint.create',
        risk: 'write',
        input: { cwd, label: `automatic checkpoint before git ${operation}` },
        provenance: { kind: 'runtime', source: action.id }
      });
      if (!checkpointResult.ok) {
        throw new OperatorError(checkpointResult.error?.code ?? 'GIT_CHECKPOINT_FAILED', checkpointResult.error?.message ?? 'Unable to create pre-write checkpoint.');
      }
      const checkpoint = checkpointResult.output as { id: string };

      if (operation === 'stage') return await this.#stage(action, started, before, checkpoint.id);
      if (operation === 'unstage') return await this.#unstage(action, started, before, checkpoint.id);
      return await this.#commit(action, started, before, checkpoint.id);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('GIT_WRITE_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('git_write', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #stage(action: ActionRequest, started: number, before: RepoState, checkpointId: string): Promise<ActionResult> {
    const paths = validatePaths(action.input.paths);
    const all = action.input.all === true;
    if (!all && paths.length === 0) throw new OperatorError('GIT_PATHS_REQUIRED', 'stage requires paths or all=true.');
    await runGit(before.root, ['add', '-A', '--', ...(all ? ['.'] : paths)], {});
    const after = await this.#inspectState(before.root);
    const staged = await runGit(before.root, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'], {});
    const stagedPaths = staged.stdout.split('\0').filter(Boolean).slice(0, 500);
    return success(action, started, 'stage', before, after, checkpointId, {
      stagedPaths,
      all
    });
  }

  async #unstage(action: ActionRequest, started: number, before: RepoState, checkpointId: string): Promise<ActionResult> {
    if (!before.head) throw new OperatorError('GIT_UNBORN_UNSTAGE_UNSUPPORTED', 'unstage currently requires an existing HEAD commit.');
    const paths = validatePaths(action.input.paths);
    const all = action.input.all === true;
    if (!all && paths.length === 0) throw new OperatorError('GIT_PATHS_REQUIRED', 'unstage requires paths or all=true.');
    await runGit(before.root, ['restore', '--staged', '--', ...(all ? ['.'] : paths)], {});
    const after = await this.#inspectState(before.root);
    return success(action, started, 'unstage', before, after, checkpointId, { all, paths: all ? [] : paths });
  }

  async #commit(action: ActionRequest, started: number, before: RepoState, checkpointId: string): Promise<ActionResult> {
    const message = String(action.input.message ?? '').trim();
    if (!message || message.length > 4000 || message.includes('\0')) {
      throw new OperatorError('INVALID_COMMIT_MESSAGE', 'commit message must contain 1-4000 characters and no NUL bytes.');
    }
    const staged = await runGit(before.root, ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv'], {}, true);
    if (staged.code === 0) throw new OperatorError('GIT_NOTHING_STAGED', 'No staged changes are available to commit.');
    if (staged.code !== 1) throw new OperatorError('GIT_STAGED_CHECK_FAILED', staged.stderr.trim() || `git diff exited ${staged.code}.`);

    const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-empty-hooks-'));
    try {
      await runGit(before.root, [
        '-c', `core.hooksPath=${hooksDir}`,
        '-c', 'commit.gpgSign=false',
        'commit', '--no-verify', '--no-gpg-sign', '-m', message
      ], {});
    } finally {
      await fs.rm(hooksDir, { recursive: true, force: true });
    }

    const newHead = (await runGit(before.root, ['rev-parse', 'HEAD'], {})).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(newHead) || newHead === before.head) {
      throw new OperatorError('GIT_COMMIT_POSTCONDITION_FAILED', 'Git commit did not advance HEAD as expected.');
    }
    const committedTree = (await runGit(before.root, ['rev-parse', 'HEAD^{tree}'], {})).stdout.trim();
    if (committedTree !== before.indexTree) {
      throw new OperatorError('GIT_COMMIT_POSTCONDITION_FAILED', 'Committed tree does not match the staged index captured by the precondition.', {
        details: { expectedIndexTree: before.indexTree, committedTree }
      });
    }
    if (before.head) {
      const parent = (await runGit(before.root, ['rev-parse', 'HEAD^'], {})).stdout.trim();
      if (parent !== before.head) {
        throw new OperatorError('GIT_COMMIT_POSTCONDITION_FAILED', 'New commit parent does not match the pre-write HEAD.', {
          details: { expectedParent: before.head, actualParent: parent }
        });
      }
    }
    const after = await this.#inspectState(before.root);
    return success(action, started, 'commit', before, after, checkpointId, {
      newHead,
      previousHead: before.head,
      committedTree,
      hooksDisabled: true,
      gpgSigningDisabled: true
    });
  }

  async #inspectState(cwd: string): Promise<RepoState> {
    const result = await this.#checkpoint.execute({
      id: crypto.randomUUID(),
      capability: 'git.checkpoint.inspect',
      risk: 'read',
      input: { cwd },
      provenance: { kind: 'runtime' }
    });
    if (!result.ok) throw new OperatorError(result.error?.code ?? 'GIT_STATE_INSPECTION_FAILED', result.error?.message ?? 'Unable to inspect Git state.');
    return (result.output as { current: RepoState }).current;
  }
}

function validatePaths(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.map(String) : [];
  if (raw.length > 200) throw new OperatorError('TOO_MANY_GIT_PATHS', 'At most 200 paths may be supplied.');
  return raw.map((item) => {
    const value = item.trim();
    if (!value || value.length > 1000 || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
      throw new OperatorError('INVALID_GIT_PATH', 'Git paths must be non-empty bounded single-line relative paths.');
    }
    if (path.isAbsolute(value) || value.startsWith(':')) throw new OperatorError('INVALID_GIT_PATH', 'Absolute paths and Git pathspec magic are not allowed.');
    const normalized = path.normalize(value);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
      throw new OperatorError('INVALID_GIT_PATH', 'Git path escapes the repository root.');
    }
    return value;
  });
}

function success(
  action: ActionRequest,
  started: number,
  operation: string,
  before: RepoState,
  after: RepoState,
  checkpointId: string,
  details: Record<string, unknown>
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'git.write.native',
    output: {
      operation,
      before,
      after,
      checkpointId,
      ...details
    },
    evidence: [
      evidence('git_write', 'pass', `Structured Git ${operation} completed without a command shell.`, { operation, checkpointId }),
      evidence('recovery_checkpoint', 'pass', 'A non-mutating checkpoint was created before the Git write.', { checkpointId }),
      evidence('postcondition', 'pass', 'Repository state was re-inspected after the Git write.', { beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint })
    ],
    durationMs: Math.round(performance.now() - started)
  };
}

async function runGit(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv, allowNonZero = false): Promise<GitOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_GIT_PREFIX, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: '', ...extraEnv }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const sliced = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      bucket.push(sliced);
      bytes += sliced.byteLength;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, 30_000);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (result.code !== 0 && !allowNonZero) {
        reject(new OperatorError('GIT_COMMAND_FAILED', result.stderr.trim().slice(0, 1200) || `git ${args[0] ?? ''} exited ${result.code}.`));
        return;
      }
      resolve(result);
    });
  });
}
