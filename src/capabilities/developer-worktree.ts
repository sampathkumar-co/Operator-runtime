import path from 'node:path';
import type {
  ActionRequest,
  ActionResult,
  CapabilityProvider,
  CapabilityScore,
  ProviderReconciliationRequest,
  ProviderReconciliationResult
} from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import {
  DeveloperWorktreeManager,
  type DeveloperWorktreeInspection
} from '../core/developer-worktree.ts';
import {
  DeveloperSessionStore,
  type DeveloperSession
} from '../core/developer-session.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.75,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.99,
  informationQuality: 0.99,
  interactionCost: 0.03
};

const TERMINAL_SESSION_STATES = new Set<DeveloperSession['status']>([
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

export class DeveloperWorktreeProvider implements CapabilityProvider {
  readonly name = 'developer.worktree.session-bound';
  #manager: DeveloperWorktreeManager;
  #sessions: DeveloperSessionStore;

  constructor(options: {
    allowedRoots: string[];
    worktreeRoot: string;
    stateDir: string;
    clock?: () => Date;
  }) {
    this.#manager = new DeveloperWorktreeManager({
      allowedRepositoryRoots: options.allowedRoots,
      worktreeRoot: options.worktreeRoot,
      stateDir: options.stateDir,
      ...(options.clock ? { clock: options.clock } : {})
    });
    this.#sessions = new DeveloperSessionStore(options.stateDir);
  }

  supports(action: ActionRequest): boolean {
    return [
      'developer.worktree.create',
      'developer.worktree.inspect',
      'developer.worktree.release'
    ].includes(action.capability);
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    let mutationDispatched = false;
    try {
      const sessionId = boundedId(action.input.sessionId, 'sessionId');
      const repositoryRootInput = boundedPath(action.input.repositoryRoot, 'repositoryRoot');

      if (action.capability === 'developer.worktree.create') {
        if (action.risk !== 'write') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'developer.worktree.create requires write risk.'
          );
        }
        const session = await this.#sessions.get(sessionId);
        if (TERMINAL_SESSION_STATES.has(session.status)) {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_SESSION_TERMINAL',
            'A terminal Developer Session cannot provision a new worktree.',
            { details: { sessionId, status: session.status } }
          );
        }
        const baseCommit = boundedCommit(action.input.baseCommit);
        mutationDispatched = true;
        const created = await this.#manager.create({
          sessionId,
          repositoryRoot: repositoryRootInput,
          baseCommit
        });
        assertRepositoryMatch(created, repositoryRootInput);
        return ok(action, started, created, {
          operation: 'create',
          sessionStatus: session.status
        });
      }

      if (action.capability === 'developer.worktree.inspect') {
        if (action.risk !== 'read') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'developer.worktree.inspect requires read risk.'
          );
        }
        const inspected = await this.#manager.inspect(sessionId);
        assertRepositoryMatch(inspected, repositoryRootInput);
        const session = await this.#optionalSession(sessionId);
        return ok(action, started, inspected, {
          operation: 'inspect',
          ...(session ? { sessionStatus: session.status } : { sessionStatus: 'MISSING' })
        });
      }

      if (action.capability === 'developer.worktree.release') {
        if (action.risk !== 'destructive') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'developer.worktree.release requires destructive risk.'
          );
        }
        const before = await this.#manager.inspect(sessionId);
        assertRepositoryMatch(before, repositoryRootInput);
        const expectedFingerprint = boundedDigest(
          action.input.expectedFingerprint,
          'expectedFingerprint'
        );
        mutationDispatched = true;
        const released = await this.#manager.release({
          sessionId,
          expectedFingerprint
        });
        assertRepositoryMatch(released, repositoryRootInput);
        const session = await this.#optionalSession(sessionId);
        return ok(action, started, released, {
          operation: 'release',
          ...(session ? { sessionStatus: session.status } : { sessionStatus: 'MISSING' })
        });
      }

      throw new OperatorError('DEVELOPER_WORKTREE_CAPABILITY_UNSUPPORTED', action.capability);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError(
          'DEVELOPER_WORKTREE_PROVIDER_ERROR',
          error instanceof Error ? error.message : String(error)
        );
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [
          evidence('developer_worktree', 'fail', op.message, { code: op.code })
        ],
        error: {
          code: op.code,
          message: op.message,
          retryable: mutationDispatched ? false : op.retryable,
          sideEffectState: mutationDispatched ? 'uncertain' : 'none',
          executionPhase: mutationDispatched ? 'dispatched' : 'pre_dispatch'
        },
        durationMs: started === 0 ? 0 : Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    request: ProviderReconciliationRequest
  ): Promise<ProviderReconciliationResult> {
    const action = request.action;
    if (!this.supports(action)) {
      return {
        status: 'uncertain',
        evidence: [
          evidence(
            'developer_worktree_reconciliation',
            'info',
            'Unsupported Developer Worktree capability cannot be reconciled by this provider.'
          )
        ]
      };
    }

    try {
      const sessionId = boundedId(action.input.sessionId, 'sessionId');
      const repositoryRoot = boundedPath(action.input.repositoryRoot, 'repositoryRoot');
      const inspected = await this.#manager.inspect(sessionId);
      assertRepositoryMatch(inspected, repositoryRoot);

      if (action.capability === 'developer.worktree.create') {
        if (inspected.record.phase === 'ACTIVE' && inspected.exists) {
          const session = await this.#optionalSession(sessionId);
          const result = ok(action, 0, inspected, {
            operation: 'create',
            reconciled: true,
            ...(session ? { sessionStatus: session.status } : { sessionStatus: 'MISSING' })
          });
          return {
            status: 'completed',
            result,
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'pass',
                'Developer Worktree creation is proven complete from the durable ownership record and exact Git worktree identity.',
                { sessionId, phase: inspected.record.phase }
              )
            ]
          };
        }
        if (inspected.record.phase === 'CREATING' && !inspected.exists) {
          return {
            status: 'not_applied',
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'pass',
                'Creation journal exists but no owned Git worktree exists or is registered.',
                { sessionId }
              )
            ]
          };
        }
      }

      if (action.capability === 'developer.worktree.release') {
        if (inspected.record.phase === 'RELEASED' && !inspected.exists) {
          const session = await this.#optionalSession(sessionId);
          const result = ok(action, 0, inspected, {
            operation: 'release',
            reconciled: true,
            ...(session ? { sessionStatus: session.status } : { sessionStatus: 'MISSING' })
          });
          return {
            status: 'completed',
            result,
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'pass',
                'Developer Worktree release is proven complete: the owned path and Git registration are absent.',
                { sessionId }
              )
            ]
          };
        }
        if (inspected.exists) {
          return {
            status: 'not_applied',
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'info',
                'The owned Developer Worktree still exists, so release has not completed.',
                { sessionId, phase: inspected.record.phase }
              )
            ]
          };
        }
      }

      if (action.capability === 'developer.worktree.inspect') {
        const session = await this.#optionalSession(sessionId);
        const result = ok(action, 0, inspected, {
          operation: 'inspect',
          reconciled: true,
          ...(session ? { sessionStatus: session.status } : { sessionStatus: 'MISSING' })
        });
        return {
          status: 'completed',
          result,
          evidence: [
            evidence(
              'developer_worktree_reconciliation',
              'pass',
              'Read-only Developer Worktree inspection was re-established from current state.',
              { sessionId }
            )
          ]
        };
      }

      return {
        status: 'uncertain',
        evidence: [
          evidence(
            'developer_worktree_reconciliation',
            'info',
            'Developer Worktree state does not prove the requested lifecycle transition.',
            { sessionId, phase: inspected.record.phase, exists: inspected.exists }
          )
        ]
      };
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'DEVELOPER_WORKTREE_NOT_FOUND') {
        return {
          status: action.capability === 'developer.worktree.create' ? 'not_applied' : 'uncertain',
          evidence: [
            evidence(
              'developer_worktree_reconciliation',
              'info',
              action.capability === 'developer.worktree.create'
                ? 'No ownership journal exists, proving creation did not reach the journal-before-mutation boundary.'
                : 'No ownership journal exists for this Developer Worktree lifecycle request.',
              { code: error.code }
            )
          ]
        };
      }
      return {
        status: 'uncertain',
        evidence: [
          evidence(
            'developer_worktree_reconciliation',
            'info',
            'Developer Worktree lifecycle state could not be reconciled safely.',
            {
              code: error instanceof OperatorError
                ? error.code
                : 'DEVELOPER_WORKTREE_RECONCILIATION_FAILED'
            }
          )
        ]
      };
    }
  }

  async #optionalSession(sessionId: string): Promise<DeveloperSession | undefined> {
    try {
      return await this.#sessions.get(sessionId);
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'DEVELOPER_SESSION_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }
}

function ok(
  action: ActionRequest,
  started: number,
  inspection: DeveloperWorktreeInspection,
  metadata: Record<string, unknown>
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'developer.worktree.session-bound',
    output: {
      sessionId: inspection.record.sessionId,
      repositoryRoot: inspection.record.repositoryRoot,
      worktreePath: inspection.record.worktreePath,
      baseCommit: inspection.record.baseCommit,
      phase: inspection.record.phase,
      exists: inspection.exists,
      ...(inspection.head ? { head: inspection.head } : {}),
      ...(inspection.clean !== undefined ? { clean: inspection.clean } : {}),
      ...(inspection.statusDigest ? { statusDigest: inspection.statusDigest } : {}),
      ...(inspection.fingerprint ? { fingerprint: inspection.fingerprint } : {}),
      ...metadata
    },
    evidence: [
      evidence(
        'developer_worktree',
        'pass',
        action.capability === 'developer.worktree.create'
          ? 'Provisioned an exact-commit detached worktree bound to an existing Developer Session.'
          : action.capability === 'developer.worktree.release'
            ? 'Released only the exact owned clean worktree under a fresh fingerprint precondition.'
            : 'Inspected the exact owned Developer Worktree without mutating it.',
        {
          sessionId: inspection.record.sessionId,
          phase: inspection.record.phase,
          baseCommit: inspection.record.baseCommit
        }
      ),
      evidence(
        'developer_worktree_authority',
        'pass',
        'Developer Worktree lifecycle remains subject to canonical runtime policy and repository/session resource leases.',
        {
          sessionId: inspection.record.sessionId,
          capability: action.capability
        }
      )
    ],
    durationMs: Math.round(performance.now() - started)
  };
}

function assertRepositoryMatch(
  inspection: DeveloperWorktreeInspection,
  requestedRepositoryRoot: string
): void {
  const requested = canonicalPath(requestedRepositoryRoot);
  const recorded = canonicalPath(inspection.record.repositoryRoot);
  if (requested !== recorded) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_REPOSITORY_PRECONDITION_CHANGED',
      'repositoryRoot does not match the Developer Worktree ownership record.'
    );
  }
}

function boundedId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,512}$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      label + ' is invalid.'
    );
  }
  return value;
}

function boundedPath(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (
    !value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 32 * 1024 ||
    !path.isAbsolute(value)
  ) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      label + ' must be a bounded absolute path.'
    );
  }
  return path.resolve(value);
}

function boundedCommit(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      'baseCommit must be a full Git object ID.'
    );
  }
  return value;
}

function boundedDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      label + ' must be SHA-256.'
    );
  }
  return value;
}

function canonicalPath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
