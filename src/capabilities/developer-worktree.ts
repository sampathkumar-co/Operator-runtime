import fs from 'node:fs/promises';
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

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.82,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.98,
  informationQuality: 0.99,
  interactionCost: 0.03
};

type WorktreeCapability =
  | 'workspace.worktree.create'
  | 'workspace.worktree.inspect'
  | 'workspace.worktree.release';

export class DeveloperWorktreeProvider implements CapabilityProvider {
  readonly name = 'workspace.worktree.git';
  #manager: DeveloperWorktreeManager;

  constructor(options: {
    allowedRepositoryRoots: string[];
    worktreeRoot: string;
    stateDir: string;
  }) {
    this.#manager = new DeveloperWorktreeManager({
      allowedRepositoryRoots: options.allowedRepositoryRoots,
      worktreeRoot: options.worktreeRoot,
      stateDir: options.stateDir
    });
  }

  supports(action: ActionRequest): boolean {
    return [
      'workspace.worktree.create',
      'workspace.worktree.inspect',
      'workspace.worktree.release'
    ].includes(action.capability);
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      const capability = action.capability as WorktreeCapability;
      const repositoryRoot = requiredPath(action.input.repositoryRoot, 'repositoryRoot');
      const sessionId = requiredId(action.input.sessionId, 'sessionId');

      if (capability === 'workspace.worktree.create') {
        if (action.risk !== 'write') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'workspace.worktree.create requires write risk.'
          );
        }
        const baseCommit = requiredCommit(action.input.baseCommit);
        const inspected = await this.#manager.create({
          sessionId,
          repositoryRoot,
          baseCommit
        });
        await assertRepositoryBinding(inspected, repositoryRoot);
        return resultFor(action, inspected, started, [
          evidence(
            'developer_worktree_create',
            'pass',
            'Created or recovered an exact detached Developer Worktree owned by this session.',
            {
              sessionId,
              baseCommit: inspected.record.baseCommit,
              clean: inspected.clean === true
            }
          ),
          evidence(
            'postcondition',
            'pass',
            'Developer Worktree HEAD exactly matches the requested commit and ownership metadata is durable.',
            { sessionId, baseCommit: inspected.record.baseCommit }
          )
        ]);
      }

      if (capability === 'workspace.worktree.inspect') {
        if (action.risk !== 'read') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'workspace.worktree.inspect requires read risk.'
          );
        }
        const inspected = await this.#manager.inspect(sessionId);
        await assertRepositoryBinding(inspected, repositoryRoot);
        return resultFor(action, inspected, started, [
          evidence(
            'developer_worktree_inspect',
            'pass',
            'Inspected only durable ownership metadata and bounded Git state for the owned Developer Worktree.',
            {
              sessionId,
              phase: inspected.record.phase,
              exists: inspected.exists,
              clean: inspected.clean ?? null
            }
          )
        ]);
      }

      if (capability === 'workspace.worktree.release') {
        if (action.risk !== 'destructive') {
          throw new OperatorError(
            'DEVELOPER_WORKTREE_RISK_MISMATCH',
            'workspace.worktree.release requires destructive risk.'
          );
        }
        const before = await this.#manager.inspect(sessionId);
        await assertRepositoryBinding(before, repositoryRoot);
        const expectedFingerprint = requiredDigest(
          action.input.expectedFingerprint,
          'expectedFingerprint'
        );
        const released = await this.#manager.release({
          sessionId,
          expectedFingerprint
        });
        await assertRepositoryBinding(released, repositoryRoot);
        return resultFor(action, released, started, [
          evidence(
            'developer_worktree_release',
            'pass',
            'Removed only a clean Mecord-owned detached worktree after an exact fingerprint precondition.',
            {
              sessionId,
              phase: released.record.phase
            }
          ),
          evidence(
            'postcondition',
            'pass',
            'Developer Worktree is no longer registered or present after release.',
            { sessionId }
          )
        ]);
      }

      throw new OperatorError('UNSUPPORTED_ACTION', action.capability);
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
          retryable: op.retryable,
          sideEffectState: op.code.includes('UNCERTAIN') ? 'uncertain' : 'none'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    request: ProviderReconciliationRequest
  ): Promise<ProviderReconciliationResult> {
    const action = request.action;
    if (
      action.capability !== 'workspace.worktree.create' &&
      action.capability !== 'workspace.worktree.release'
    ) {
      return {
        status: 'uncertain',
        evidence: [
          evidence(
            'developer_worktree_reconciliation',
            'info',
            'Only create and release have side-effect reconciliation contracts.'
          )
        ]
      };
    }

    try {
      const sessionId = requiredId(action.input.sessionId, 'sessionId');
      const repositoryRoot = requiredPath(action.input.repositoryRoot, 'repositoryRoot');
      let inspected: DeveloperWorktreeInspection;
      try {
        inspected = await this.#manager.inspect(sessionId);
      } catch (error) {
        if (
          error instanceof OperatorError &&
          error.code === 'DEVELOPER_WORKTREE_NOT_FOUND'
        ) {
          return {
            status: 'not_applied',
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'pass',
                'No durable ownership record exists for this worktree action.'
              )
            ]
          };
        }
        throw error;
      }
      await assertRepositoryBinding(inspected, repositoryRoot);

      if (action.capability === 'workspace.worktree.create') {
        const expectedCommit = requiredCommit(action.input.baseCommit);
        if (
          inspected.record.phase === 'ACTIVE' &&
          inspected.exists &&
          inspected.head === expectedCommit
        ) {
          const result = resultFor(action, inspected, 0, [
            evidence(
              'developer_worktree_reconciliation',
              'pass',
              'Owned worktree exists at the exact requested detached commit.',
              { sessionId, baseCommit: expectedCommit }
            )
          ]);
          return {
            status: 'completed',
            result,
            evidence: structuredClone(result.evidence)
          };
        }
        if (
          inspected.record.phase === 'CREATING' &&
          inspected.exists === false
        ) {
          return {
            status: 'not_applied',
            evidence: [
              evidence(
                'developer_worktree_reconciliation',
                'pass',
                'Creation journal exists but no worktree path or Git registration exists.'
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
              'Developer Worktree creation state does not satisfy a proven completed or not-applied condition.',
              { sessionId, phase: inspected.record.phase }
            )
          ]
        };
      }

      if (inspected.record.phase === 'RELEASED' && !inspected.exists) {
        const result = resultFor(action, inspected, 0, [
          evidence(
            'developer_worktree_reconciliation',
            'pass',
            'Owned worktree is durably released and absent.',
            { sessionId }
          )
        ]);
        return {
          status: 'completed',
          result,
          evidence: structuredClone(result.evidence)
        };
      }

      if (inspected.record.phase === 'ACTIVE' && inspected.exists) {
        return {
          status: 'not_applied',
          evidence: [
            evidence(
              'developer_worktree_reconciliation',
              'pass',
              'Owned worktree is still active, proving release was not applied.',
              { sessionId, fingerprint: inspected.fingerprint ?? null }
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
            'Developer Worktree release state remains unresolved.',
            { sessionId, phase: inspected.record.phase }
          )
        ]
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError(
          'DEVELOPER_WORKTREE_RECONCILIATION_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      return {
        status: 'uncertain',
        evidence: [
          evidence(
            'developer_worktree_reconciliation',
            'info',
            'Developer Worktree post-state could not be proven.',
            { code: op.code }
          )
        ]
      };
    }
  }
}

function resultFor(
  action: ActionRequest,
  inspected: DeveloperWorktreeInspection,
  started: number,
  proof: ActionResult['evidence']
): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'workspace.worktree.git',
    output: {
      sessionId: inspected.record.sessionId,
      repositoryRoot: inspected.record.repositoryRoot,
      worktreePath: inspected.record.worktreePath,
      baseCommit: inspected.record.baseCommit,
      phase: inspected.record.phase,
      exists: inspected.exists,
      ...(inspected.head ? { head: inspected.head } : {}),
      ...(inspected.clean !== undefined ? { clean: inspected.clean } : {}),
      ...(inspected.statusDigest ? { statusDigest: inspected.statusDigest } : {}),
      ...(inspected.fingerprint ? { fingerprint: inspected.fingerprint } : {})
    },
    evidence: proof,
    durationMs: started === 0 ? 0 : Math.round(performance.now() - started)
  };
}

function await assertRepositoryBinding(
  inspected: DeveloperWorktreeInspection,
  requested: string
): void {
  const left = canonicalPath(inspected.record.repositoryRoot);
  const right = canonicalPath(requested);
  if (left !== right) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_REPOSITORY_BINDING_MISMATCH',
      'Worktree session is bound to a different repository root.'
    );
  }
}

function requiredPath(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 32 * 1024) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      label + ' is invalid.'
    );
  }
  return path.resolve(value);
}

function requiredId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      label + ' is invalid.'
    );
  }
  return value;
}

function requiredCommit(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new OperatorError(
      'DEVELOPER_WORKTREE_INPUT_INVALID',
      'baseCommit must be a full Git commit object ID.'
    );
  }
  return value;
}

function requiredDigest(input: unknown, label: string): string {
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
