import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { reconcileFromDurableResult } from '../core/reconciliation-coverage.ts';
import { resolveSupportedGitExecutable } from '../core/trusted-executable.ts';
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

const DISABLED_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SAFE_GIT_PREFIX = ['--no-pager', '--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${DISABLED_HOOKS_PATH}`, '--literal-pathspecs'];
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

  supports(action: ActionRequest): boolean {
    return action.capability === 'git.write';
  }

  advertises(action: ActionRequest): boolean {
    if (!this.supports(action)) return false;
    try { resolveSupportedGitExecutable(gitEnvironment({})); return true; } catch { return false; }
  }
  score(): CapabilityScore { return SCORE; }

  async reconcile(request: ProviderReconciliationRequest, context: CapabilityExecutionContext = {}): Promise<ProviderReconciliationResult> {
    assertGitWriteNotStopped(context.signal, false);
    return reconcileFromDurableResult(this.name, request.action.capability, request.priorResult);
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    let checkpointStarted = false;
    let mutationStarted = false;
    try {
      assertGitWriteNotStopped(context.signal, false);
      if (!this.supports(action)) throw new OperatorError('UNSUPPORTED_ACTION', 'Git write provider does not support this capability.');
      // Fail before any Git process or checkpoint can change repository refs.
      const operation = action.input.operation;
      if (typeof operation !== 'string' || !['stage', 'unstage', 'commit'].includes(operation)) {
        throw new OperatorError('INVALID_GIT_WRITE_OPERATION', 'operation must be an exact stage, unstage, or commit string.');
      }
      const cwd = action.input.cwd;
      if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || /[\0\r\n]/.test(cwd)) {
        throw new OperatorError('GIT_WRITE_CWD_INVALID', 'Git working directory must be a bounded exact path.');
      }
      const expectedCurrentFingerprint = action.input.expectedCurrentFingerprint;
      if (typeof expectedCurrentFingerprint !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(expectedCurrentFingerprint)) {
        throw new OperatorError('GIT_WRITE_FINGERPRINT_REQUIRED', 'An exact fingerprint from git.checkpoint inspect is required.');
      }
      if (action.input.all !== undefined && typeof action.input.all !== 'boolean') {
        throw new OperatorError('GIT_PATH_SELECTION_INVALID', 'Git all flag must be an exact Boolean.');
      }
      const proposedPaths = validatePaths(action.input.paths);
      if (operation === 'stage' || operation === 'unstage') {
        if (action.input.all === true && proposedPaths.length > 0) {
          throw new OperatorError('GIT_PATH_SELECTION_INVALID', 'Select either all=true or explicit paths, never both.');
        }
        if (action.input.all !== true && proposedPaths.length === 0) {
          throw new OperatorError('GIT_PATHS_REQUIRED', 'Git stage/unstage requires exact paths or all=true.');
        }
        if (action.input.message !== undefined) {
          throw new OperatorError('GIT_WRITE_INPUT_INVALID', 'Commit message is not an input for stage or unstage.');
        }
      } else {
        if (action.input.paths !== undefined || action.input.all !== undefined) {
          throw new OperatorError('GIT_WRITE_INPUT_INVALID', 'Git commit uses only the previously staged index; paths/all are not accepted.');
        }
        const message = action.input.message;
        if (typeof message !== 'string' || !message.trim() ||
            message.length > 4000 || message.includes('\0')) {
          throw new OperatorError('INVALID_COMMIT_MESSAGE', 'Commit message must be an exact nonempty bounded string.');
        }
      }
      resolveSupportedGitExecutable(gitEnvironment({}));
      assertGitWriteNotStopped(context.signal, false);
      const before = await this.#inspectState(cwd);
      assertGitWriteNotStopped(context.signal, false);
      if (before.fingerprint !== expectedCurrentFingerprint) {
        throw new OperatorError('GIT_WRITE_STATE_CHANGED', 'Repository state changed after the supplied write precondition was captured.', {
          retryable: true,
          details: { expectedCurrentFingerprint, actualCurrentFingerprint: before.fingerprint }
        });
      }

      assertGitWriteNotStopped(context.signal, false);
      checkpointStarted = true;
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
      // Checkpoint creation itself may modify owned recovery refs. If Stop
      // arrived during that asynchronous phase, never begin the user Git
      // mutation; preserve uncertainty rather than pretending zero effects.
      assertGitWriteNotStopped(context.signal, true);

      mutationStarted = true;
      if (operation === 'stage') return await this.#stage(action, started, before, checkpoint.id);
      if (operation === 'unstage') return await this.#unstage(action, started, before, checkpoint.id);
      return await this.#commit(action, started, before, checkpoint.id);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('GIT_WRITE_ERROR', error instanceof Error ? error.message : String(error));
      // The checkpoint may have changed owned Git refs, and the command may
      // have changed the index/HEAD before failing. Never authorize an
      // automatic replay merely because a child process returned an error.
      const afterDispatch = checkpointStarted || mutationStarted;
      const sideEffectState = op.details && ['none','known','uncertain'].includes(String(op.details.sideEffectState))
        ? op.details.sideEffectState as 'none' | 'known' | 'uncertain'
        : afterDispatch ? 'uncertain' : 'none';
      const executionPhase = op.details && ['pre_dispatch','dispatched','effect_observed','reconciled'].includes(String(op.details.executionPhase))
        ? op.details.executionPhase as 'pre_dispatch' | 'dispatched' | 'effect_observed' | 'reconciled'
        : afterDispatch ? 'dispatched' : 'pre_dispatch';
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('git_write', 'fail', op.message, { code: op.code, afterDispatch })],
        error: {
          code: op.code, message: op.message,
          retryable: afterDispatch ? false : op.retryable,
          sideEffectState, executionPhase
        },
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

    const identity = await commitIdentityEnv(before.root);
    const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-empty-hooks-'));
    try {
      await runGit(before.root, [
        '-c', `core.hooksPath=${hooksDir}`,
        '-c', 'commit.gpgSign=false',
        'commit', '--no-verify', '--no-gpg-sign', '-m', message
      ], identity);
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

function assertGitWriteNotStopped(signal: AbortSignal | undefined, checkpointMayExist: boolean): void {
  if (!signal?.aborted) return;
  throw new OperatorError('EXECUTION_ABORTED',
    checkpointMayExist
      ? 'Git write stopped after recovery checkpoint preparation; no new user Git mutation was started.'
      : 'Git write stopped before execution.', {
      retryable: false,
      details: {
        sideEffectState: checkpointMayExist ? 'uncertain' : 'none',
        executionPhase: checkpointMayExist ? 'dispatched' : 'pre_dispatch'
      }
    });
}

function validatePaths(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new OperatorError('GIT_PATH_SELECTION_INVALID', 'Git paths must be an exact array of strings.');
  const raw = input;
  if (raw.length > 200) throw new OperatorError('TOO_MANY_GIT_PATHS', 'At most 200 paths may be supplied.');
  return raw.map((item) => {
    if (typeof item !== 'string') throw new OperatorError('INVALID_GIT_PATH', 'Git path must be a literal string.');
    const value = item;
    if (!value || value !== value.trim() || value.length > 1000 || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
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

async function commitIdentityEnv(root: string): Promise<NodeJS.ProcessEnv> {
  const [nameResult, emailResult] = await Promise.all([
    runGit(root, ['config', '--local', '--get', 'user.name'], {}, true),
    runGit(root, ['config', '--local', '--get', 'user.email'], {}, true)
  ]);
  for (const result of [nameResult, emailResult]) {
    if (![0, 1].includes(result.code)) {
      throw new OperatorError('GIT_CONFIG_INSPECTION_FAILED', result.stderr.trim() || 'Unable to inspect repository-local Git identity.');
    }
  }
  let name = 'Operator';
  let email = 'operator@local.invalid';
  if (nameResult.code === 0 && emailResult.code === 0) {
    const localName = nameResult.stdout.trim();
    const localEmail = emailResult.stdout.trim();
    if (!localName || localName.length > 200 || /[\0\r\n]/.test(localName)) throw new OperatorError('GIT_IDENTITY_INVALID', 'Repository-local Git user.name is invalid.');
    if (!localEmail || localEmail.length > 320 || /[\0\r\n]/.test(localEmail)) throw new OperatorError('GIT_IDENTITY_INVALID', 'Repository-local Git user.email is invalid.');
    name = localName;
    email = localEmail;
  }
  return {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email
  };
}

function gitEnvironment(extraEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env: NodeJS.ProcessEnv = {
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_CONFIG_SYSTEM: nullConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1'
  };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER', 'USERNAME', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runGit(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv, allowNonZero = false): Promise<GitOutput> {
  return await new Promise((resolve, reject) => {
    const environment = gitEnvironment(extraEnv);
    const gitExecutable = resolveSupportedGitExecutable(environment);
    const child = spawn(gitExecutable, [...SAFE_GIT_PREFIX, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment
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
