import path from 'node:path';
import type {
  ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider,
  CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult
} from '../core/types.ts';
import { DeveloperWorktreeManager, type DeveloperWorktreeInspection } from '../core/developer-worktree.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';

/**
 * Private source-only adapter. No runtime-factory, MCP route, public tool, or
 * capability-risk registration is installed by this module.
 *
 * Create/release authority must be wired separately after reviewed
 * resource-identity, cancellation, canonical-risk and approval parity.
 */
type WorktreeOperation = 'workspace.worktree.create' | 'workspace.worktree.inspect' | 'workspace.worktree.release';

const RISKS: Record<WorktreeOperation, 'write' | 'read' | 'destructive'> = {
  'workspace.worktree.create': 'write',
  'workspace.worktree.inspect': 'read',
  'workspace.worktree.release': 'destructive'
};
const SCORE: CapabilityScore = {
  reliability: 0.8, latency: 0.5, determinism: 0.9,
  security: 0.9, reversibility: 0.7, informationQuality: 0.8, interactionCost: 0.1
};

function literalField(input: Record<string, unknown>, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null)) {
    throw new OperatorError('DEVELOPER_WORKTREE_INPUT_INVALID', 'Worktree action input is not an inert object.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor) ||
      typeof descriptor.value !== 'string') {
    throw new OperatorError('DEVELOPER_WORKTREE_INPUT_INVALID', key + ' must be a literal string.');
  }
  return descriptor.value;
}
function requiredSession(value: string): string {
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(value)) {
    throw new OperatorError('DEVELOPER_WORKTREE_INPUT_INVALID', 'Session identity is invalid.');
  }
  return value;
}
function requiredPath(value: string): string {
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 32768) {
    throw new OperatorError('DEVELOPER_WORKTREE_INPUT_INVALID', 'Repository path is invalid.');
  }
  return path.resolve(value);
}
function requiredDigest(value: string, label: string, lengths: number[]): string {
  if (!lengths.includes(value.length) || !/^[0-9a-f]+$/i.test(value)) {
    throw new OperatorError('DEVELOPER_WORKTREE_INPUT_INVALID', label + ' must be a full hexadecimal digest.');
  }
  return value.toLowerCase();
}
function exactRepository(inspected: DeveloperWorktreeInspection, requested: string): void {
  const norm = (raw: string) => {
    const resolved = path.resolve(raw).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (norm(inspected.record.repositoryRoot) !== norm(requested)) {
    throw new OperatorError('DEVELOPER_WORKTREE_REPOSITORY_BINDING_MISMATCH',
      'Session belongs to a different repository root.');
  }
}
function asOutput(inspected: DeveloperWorktreeInspection): Record<string, unknown> {
  return {
    sessionId: inspected.record.sessionId,
    repositoryRoot: inspected.record.repositoryRoot,
    worktreePath: inspected.record.worktreePath,
    baseCommit: inspected.record.baseCommit,
    phase: inspected.record.phase,
    exists: inspected.exists,
    ...(inspected.head ? { head: inspected.head } : {}),
    ...(inspected.clean !== undefined ? { clean: inspected.clean } : {}),
    ...(inspected.fingerprint ? { fingerprint: inspected.fingerprint } : {}),
    ...(inspected.statusDigest ? { statusDigest: inspected.statusDigest } : {})
  };
}
function successful(action: ActionRequest, inspected: DeveloperWorktreeInspection, started: number): ActionResult {
  return {
    ok: true, capability: action.capability, provider: 'workspace.worktree.git',
    output: asOutput(inspected),
    evidence: [evidence('developer_worktree_state', 'pass',
      'Owned detached worktree operation matched an independently inspected Git post-state.',
      { phase: inspected.record.phase, exists: inspected.exists })],
    durationMs: Math.round(performance.now() - started)
  };
}

export class DeveloperWorktreeProvider implements CapabilityProvider {
  readonly name = 'workspace.worktree.git';
  readonly #manager: DeveloperWorktreeManager;

  constructor(options: { allowedRepositoryRoots: string[]; worktreeRoot: string; stateDir: string }) {
    this.#manager = new DeveloperWorktreeManager(options);
  }

  supports(action: ActionRequest): boolean {
    return Object.prototype.hasOwnProperty.call(RISKS, action.capability);
  }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    let mutationEntered = false;
    try {
      if (!this.supports(action)) {
        throw new OperatorError('UNSUPPORTED_ACTION', 'Not a Developer Worktree action.');
      }
      const operation = action.capability as WorktreeOperation;
      if (action.risk !== RISKS[operation]) {
        throw new OperatorError('DEVELOPER_WORKTREE_RISK_MISMATCH',
          'Developer Worktree action risk disagrees with the canonical private operation risk.');
      }
      if (context.signal?.aborted) {
        throw new OperatorError('DEVELOPER_WORKTREE_CANCELLED', 'Worktree action cancelled before dispatch.');
      }
      const sessionId = requiredSession(literalField(action.input, 'sessionId'));
      const repositoryRoot = requiredPath(literalField(action.input, 'repositoryRoot'));

      if (operation === 'workspace.worktree.create') {
        const baseCommit = requiredDigest(literalField(action.input, 'baseCommit'), 'baseCommit', [40, 64]);
        mutationEntered = true;
        const inspected = await this.#manager.create({ sessionId, repositoryRoot, baseCommit });
        exactRepository(inspected, repositoryRoot);
        if (inspected.record.phase !== 'ACTIVE' || !inspected.exists ||
            inspected.head !== baseCommit || inspected.clean !== true) {
          throw new OperatorError('DEVELOPER_WORKTREE_CREATE_UNCERTAIN',
            'Worktree creation lacks exact clean detached HEAD proof.');
        }
        return successful(action, inspected, started);
      }
      if (operation === 'workspace.worktree.inspect') {
        const inspected = await this.#manager.inspectReadOnly(sessionId);
        exactRepository(inspected, repositoryRoot);
        return successful(action, inspected, started);
      }

      const expectedFingerprint = requiredDigest(
        literalField(action.input, 'expectedFingerprint'), 'expectedFingerprint', [64]);
      const before = await this.#manager.inspect(sessionId);
      exactRepository(before, repositoryRoot);
      mutationEntered = true;
      const inspected = await this.#manager.release({ sessionId, expectedFingerprint });
      exactRepository(inspected, repositoryRoot);
      if (inspected.record.phase !== 'RELEASED' || inspected.exists) {
        throw new OperatorError('DEVELOPER_WORKTREE_RELEASE_UNCERTAIN',
          'Release lacks an independently proved terminal absence.');
      }
      return successful(action, inspected, started);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error : new OperatorError('DEVELOPER_WORKTREE_UNCERTAIN',
            'Developer Worktree operation did not return an authoritative completion receipt.');
      return {
        ok: false, capability: action.capability, provider: this.name,
        evidence: [evidence('developer_worktree', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code, message: op.message, retryable: false,
          sideEffectState: mutationEntered ? 'uncertain' : 'none',
          executionPhase: mutationEntered ? 'dispatched' : 'pre_dispatch'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(request: ProviderReconciliationRequest): Promise<ProviderReconciliationResult> {
    const action = request.action;
    if (!this.supports(action) || action.capability === 'workspace.worktree.inspect' ||
        action.risk !== RISKS[action.capability as WorktreeOperation]) {
      return { status: 'uncertain', evidence: [evidence('developer_worktree_reconciliation', 'info',
        'Only a create or release can be reconciled through the owned worktree receipt.')] };
    }
    try {
      const sessionId = requiredSession(literalField(action.input, 'sessionId'));
      const repositoryRoot = requiredPath(literalField(action.input, 'repositoryRoot'));
      const inspected = await this.#manager.inspect(sessionId);
      exactRepository(inspected, repositoryRoot);
      if (action.capability === 'workspace.worktree.create') {
        const baseCommit = requiredDigest(literalField(action.input, 'baseCommit'), 'baseCommit', [40, 64]);
        if (inspected.record.phase === 'ACTIVE' && inspected.exists &&
            inspected.head === baseCommit && inspected.clean === true) {
          return { status: 'completed', result: successful(action, inspected, 0),
            evidence: [evidence('developer_worktree_reconciliation', 'pass',
              'Exact detached commit and clean owned worktree are independently present.')] };
        }
      } else if (action.capability === 'workspace.worktree.release') {
        requiredDigest(literalField(action.input, 'expectedFingerprint'), 'expectedFingerprint', [64]);
        if (inspected.record.phase === 'RELEASED' && !inspected.exists) {
          // The terminal record does not persist the fingerprint that
          // authorized release. Absence alone cannot bind an arbitrary
          // release action to that particular previous mutation.
          return { status: 'uncertain', evidence: [evidence('developer_worktree_reconciliation', 'info',
            'Terminal release is absent but not provably bound to this requested fingerprint.')] };
        }
      }
    } catch {
      // No durable journal does not prove no Git side effect occurred. A
      // persisted CREATING/RELEASING crash window must remain uncertain.
    }
    return { status: 'uncertain', evidence: [evidence('developer_worktree_reconciliation', 'info',
      'Exact worktree post-state could not be established; no retry is authorized.')] };
  }
}
