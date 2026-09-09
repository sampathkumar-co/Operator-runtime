import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.92,
  determinism: 0.99,
  security: 0.98,
  reversibility: 0.99,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const REF_PREFIX = 'refs/operator/checkpoints/';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SAFE_GIT_PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false'];

type RepoState = {
  root: string;
  head?: string;
  indexTree: string;
  worktreeTree: string;
  fingerprint: string;
};

type CheckpointRecord = RepoState & {
  id: string;
  ref: string;
  commit: string;
  createdAt: string;
  label?: string;
};

type GitOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

export class GitCheckpointProvider implements CapabilityProvider {
  readonly name = 'git.checkpoint.native';
  #scope: PathScope;

  constructor(options: { allowedRoots: string[] }) {
    this.#scope = new PathScope(options.allowedRoots);
  }

  supports(action: ActionRequest): boolean {
    return ['git.checkpoint.create', 'git.checkpoint.inspect', 'git.checkpoint.restore'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.capability === 'git.checkpoint.create') return await this.#create(action, started);
      if (action.capability === 'git.checkpoint.inspect') return await this.#inspect(action, started);
      if (action.capability === 'git.checkpoint.restore') return await this.#restore(action, started);
      throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('GIT_CHECKPOINT_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('git_checkpoint', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #create(action: ActionRequest, started: number): Promise<ActionResult> {
    const cwd = String(action.input.cwd ?? '');
    const label = typeof action.input.label === 'string' ? action.input.label.trim().slice(0, 160) : undefined;
    const checkpoint = await this.#createCheckpoint(cwd, label);
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: checkpoint,
      evidence: [
        evidence('git_checkpoint', 'pass', 'Checkpoint stored in the repository object database without moving HEAD, branch, index, or working tree.', {
          checkpointId: checkpoint.id,
          commit: checkpoint.commit,
          head: checkpoint.head,
          indexTree: checkpoint.indexTree,
          worktreeTree: checkpoint.worktreeTree
        }),
        evidence('git_execution_boundary', 'pass', 'Repository-local clean/smudge/process filters were absent before Git materialized the checkpoint tree.'),
        evidence('postcondition', 'pass', 'Repository state fingerprint is unchanged after checkpoint creation.', { fingerprint: checkpoint.fingerprint })
      ],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #inspect(action: ActionRequest, started: number): Promise<ActionResult> {
    const cwd = String(action.input.cwd ?? '');
    const state = await this.#captureState(cwd);
    const refs = await runGit(state.root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(creatordate:iso-strict)', REF_PREFIX], {});
    const checkpoints = refs.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 200)
      .flatMap((line) => {
        const [ref, commit, createdAt] = line.split('\0');
        if (!ref?.startsWith(REF_PREFIX) || !commit) return [];
        return [{ id: ref.slice(REF_PREFIX.length), ref, commit, createdAt: createdAt ?? '' }];
      });
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { current: state, checkpoints },
      evidence: [evidence('git_checkpoint_state', 'pass', 'Current repository snapshot fingerprint and bounded checkpoint refs inspected.', {
        fingerprint: state.fingerprint,
        checkpointCount: checkpoints.length
      })],
      durationMs: Math.round(performance.now() - started)
    };
  }

  async #restore(action: ActionRequest, started: number): Promise<ActionResult> {
    const cwd = String(action.input.cwd ?? '');
    const checkpointId = validateCheckpointId(String(action.input.checkpointId ?? ''));
    const expectedCurrentFingerprint = String(action.input.expectedCurrentFingerprint ?? '');
    if (!/^[0-9a-f]{64}$/i.test(expectedCurrentFingerprint)) {
      throw new OperatorError('CHECKPOINT_FINGERPRINT_REQUIRED', 'expectedCurrentFingerprint from git.checkpoint.inspect is required for restore.');
    }

    const current = await this.#captureState(cwd);
    if (current.fingerprint !== expectedCurrentFingerprint) {
      throw new OperatorError('CHECKPOINT_STATE_CHANGED', 'Repository state changed after the supplied restore precondition was captured.', {
        retryable: true,
        details: { expectedCurrentFingerprint, actualCurrentFingerprint: current.fingerprint }
      });
    }

    const target = await this.#readCheckpoint(current.root, checkpointId);
    if (target.head !== current.head) {
      throw new OperatorError('CHECKPOINT_HEAD_CHANGED', 'Current HEAD differs from the checkpoint base HEAD; refusing to overwrite a different revision.', {
        details: { checkpointHead: target.head, currentHead: current.head }
      });
    }

    const recovery = await this.#createCheckpoint(current.root, `automatic recovery before restore ${checkpointId}`);
    try {
      await this.#restoreState(current.root, target);
      const restored = await this.#captureState(current.root);
      if (restored.head !== target.head || restored.indexTree !== target.indexTree || restored.worktreeTree !== target.worktreeTree) {
        throw new OperatorError('CHECKPOINT_RESTORE_POSTCONDITION_FAILED', 'Git restore completed but repository trees do not match the checkpoint.', {
          details: { expected: target, actual: restored }
        });
      }
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: {
          checkpointId,
          restored,
          recoveryCheckpointId: recovery.id,
          recoveryFingerprint: recovery.fingerprint
        },
        evidence: [
          evidence('git_checkpoint_restore', 'pass', 'Working tree and index restored to the checkpoint while HEAD remained unchanged.', {
            checkpointId,
            head: restored.head,
            indexTree: restored.indexTree,
            worktreeTree: restored.worktreeTree
          }),
          evidence('recovery_checkpoint', 'pass', 'A pre-restore recovery checkpoint was retained so the restore itself can be undone.', { recoveryCheckpointId: recovery.id }),
          evidence('postcondition', 'pass', 'Restored index and working-tree tree hashes exactly match the checkpoint.', { fingerprint: restored.fingerprint })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      try {
        await this.#restoreState(current.root, recovery);
        throw new OperatorError('CHECKPOINT_RESTORE_FAILED_RECOVERED', error instanceof Error ? error.message : String(error), {
          retryable: true,
          details: { recoveryCheckpointId: recovery.id }
        });
      } catch (rollbackError) {
        if (rollbackError instanceof OperatorError && rollbackError.code === 'CHECKPOINT_RESTORE_FAILED_RECOVERED') throw rollbackError;
        throw new OperatorError('CHECKPOINT_RESTORE_AND_RECOVERY_FAILED', 'Checkpoint restore failed and automatic recovery could not be verified.', {
          details: {
            restoreError: error instanceof Error ? error.message : String(error),
            recoveryError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            recoveryCheckpointId: recovery.id
          }
        });
      }
    }
  }

  async #createCheckpoint(cwd: string, label?: string): Promise<CheckpointRecord> {
    const before = await this.#captureState(cwd);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const message = [
      `Operator checkpoint ${id}`,
      '',
      `Operator-Checkpoint-Version: 1`,
      `Operator-Index-Tree: ${before.indexTree}`,
      `Operator-Base-Head: ${before.head ?? 'UNBORN'}`,
      `Operator-Created-At: ${createdAt}`,
      ...(label ? [`Operator-Label: ${label.replace(/[\r\n]+/g, ' ')}`] : [])
    ].join('\n');
    const args = ['commit-tree', before.worktreeTree];
    if (before.head) args.push('-p', before.head);
    args.push('-m', message);
    const commit = (await runGit(before.root, args, checkpointIdentityEnv())).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new OperatorError('CHECKPOINT_COMMIT_FAILED', 'Git did not return a checkpoint commit object.');
    const ref = `${REF_PREFIX}${id}`;
    await runGit(before.root, ['update-ref', ref, commit], {});
    const after = await this.#captureState(before.root);
    if (after.fingerprint !== before.fingerprint) {
      throw new OperatorError('CHECKPOINT_MUTATED_WORKTREE', 'Checkpoint creation unexpectedly changed repository state.');
    }
    return { ...before, id, ref, commit, createdAt, label };
  }

  async #captureState(cwd: string): Promise<RepoState> {
    const requested = await this.#scope.resolveExisting(cwd);
    const rootResult = await runGit(requested, ['rev-parse', '--show-toplevel'], {});
    const root = await this.#scope.resolveExisting(rootResult.stdout.trim());
    await assertNoRepoLocalContentFilters(root);
    const headResult = await runGit(root, ['rev-parse', '--verify', 'HEAD'], {}, true);
    const head = headResult.code === 0 ? headResult.stdout.trim() : undefined;
    const indexTree = (await runGit(root, ['write-tree'], {})).stdout.trim();
    const worktreeTree = await snapshotWorktreeTree(root, head);
    const fingerprint = crypto.createHash('sha256').update(`${head ?? 'UNBORN'}\0${indexTree}\0${worktreeTree}`).digest('hex');
    return { root, head, indexTree, worktreeTree, fingerprint };
  }

  async #readCheckpoint(root: string, id: string): Promise<CheckpointRecord> {
    const ref = `${REF_PREFIX}${id}`;
    const commitResult = await runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`], {}, true);
    if (commitResult.code !== 0) throw new OperatorError('CHECKPOINT_NOT_FOUND', `Checkpoint ${id} was not found.`);
    const commit = commitResult.stdout.trim();
    const raw = (await runGit(root, ['cat-file', 'commit', commit], {})).stdout;
    const [headers, ...messageParts] = raw.split('\n\n');
    const tree = headers.split(/\r?\n/).find((line) => line.startsWith('tree '))?.slice(5).trim();
    const parent = headers.split(/\r?\n/).find((line) => line.startsWith('parent '))?.slice(7).trim();
    const message = messageParts.join('\n\n');
    const indexTree = trailer(message, 'Operator-Index-Tree');
    const baseHead = trailer(message, 'Operator-Base-Head');
    const createdAt = trailer(message, 'Operator-Created-At');
    const label = trailer(message, 'Operator-Label');
    if (!tree || !indexTree || !baseHead || !createdAt) throw new OperatorError('CHECKPOINT_METADATA_INVALID', 'Checkpoint metadata is incomplete.');
    const head = baseHead === 'UNBORN' ? undefined : baseHead;
    if ((head ?? undefined) !== (parent ?? undefined)) throw new OperatorError('CHECKPOINT_METADATA_INVALID', 'Checkpoint parent does not match recorded base HEAD.');
    const fingerprint = crypto.createHash('sha256').update(`${head ?? 'UNBORN'}\0${indexTree}\0${tree}`).digest('hex');
    return { root, head, indexTree, worktreeTree: tree, fingerprint, id, ref, commit, createdAt, label };
  }

  async #restoreState(root: string, state: Pick<RepoState, 'indexTree' | 'worktreeTree'>): Promise<void> {
    await assertNoRepoLocalContentFilters(root);
    const current = await this.#captureState(root);
    const diff = await runGit(root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', state.worktreeTree, current.worktreeTree], {});
    for (const item of parseNameStatus(diff.stdout)) {
      const absolute = path.resolve(root, item.path);
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new OperatorError('CHECKPOINT_PATH_ESCAPE', 'Git diff returned an unsafe restore path.');
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new OperatorError('CHECKPOINT_DIRECTORY_CONFLICT', `Refusing to recursively delete directory ${item.path} during restore.`);
        }
        await fs.rm(absolute, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await runGit(root, ['read-tree', '--reset', '-u', state.worktreeTree], {});
    await runGit(root, ['read-tree', state.indexTree], {});
  }
}

function validateCheckpointId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new OperatorError('INVALID_CHECKPOINT_ID', 'checkpointId is invalid.');
  return value;
}

function trailer(message: string, key: string): string | undefined {
  const prefix = `${key}: `;
  return message.split(/\r?\n/).find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

function parseNameStatus(raw: string): Array<{ status: string; path: string }> {
  const fields = raw.split('\0').filter(Boolean);
  const output: Array<{ status: string; path: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? '';
    const file = fields[index + 1] ?? '';
    if (!/^[AMD]$/.test(status) || !file) throw new OperatorError('CHECKPOINT_DIFF_INVALID', 'Unexpected Git name-status output during restore.');
    output.push({ status, path: file });
  }
  return output;
}

async function assertNoRepoLocalContentFilters(root: string): Promise<void> {
  const configured = await runGit(root, ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], {}, true);
  if (configured.code === 0 && configured.stdout.trim()) {
    throw new OperatorError('GIT_LOCAL_FILTER_DENIED', 'Repository-local Git clean/smudge/process filters are disabled for checkpoint operations because they can execute arbitrary commands.', {
      details: { keys: configured.stdout.split(/\r?\n/).filter(Boolean).slice(0, 50) }
    });
  }
  if (![0, 1].includes(configured.code)) {
    throw new OperatorError('GIT_CONFIG_INSPECTION_FAILED', configured.stderr.trim() || 'Unable to inspect repository-local Git filter configuration.');
  }
}

async function snapshotWorktreeTree(root: string, head?: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-git-index-'));
  const indexPath = path.join(tempDir, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    if (head) await runGit(root, ['read-tree', head], env);
    else await runGit(root, ['read-tree', '--empty'], env);
    await runGit(root, ['add', '-A', '--', '.'], env);
    return (await runGit(root, ['write-tree'], env)).stdout.trim();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function checkpointIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Operator Checkpoint',
    GIT_AUTHOR_EMAIL: 'operator@local.invalid',
    GIT_COMMITTER_NAME: 'Operator Checkpoint',
    GIT_COMMITTER_EMAIL: 'operator@local.invalid'
  };
}

async function runGit(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv, allowNonZero = false): Promise<GitOutput> {
  return await new Promise((resolve, reject) => {
    const safeArgs = [...SAFE_GIT_PREFIX, ...args];
    const child = spawn('git', safeArgs, {
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
      const remaining = MAX_OUTPUT_BYTES - bytes;
      const sliced = chunk.subarray(0, remaining);
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
        reject(new OperatorError('GIT_COMMAND_FAILED', `git ${args[0] ?? ''} failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.code}`}`));
        return;
      }
      resolve(result);
    });
  });
}
