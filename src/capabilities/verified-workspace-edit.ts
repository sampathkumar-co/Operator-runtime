import type {
  ActionRequest,
  ActionResult,
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityScore,
  ProviderReconciliationRequest,
  ProviderReconciliationResult
} from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { validateMultiFileEditPlan, type MultiFileEditPlan } from '../core/multi-file-edit-plan.ts';
import { ProjectCommandProvider } from './project-command.ts';
import { WorkspaceEditTransactionProvider } from './workspace-edit-transaction.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.72,
  determinism: 0.99,
  security: 0.99,
  reversibility: 0.99,
  informationQuality: 0.99,
  interactionCost: 0.05
};

type RegisteredCommand = {
  id: string;
  kind?: string;
  risk: 'read' | 'write' | 'external';
  artifacts?: Array<{ mustChange?: boolean }>;
};

type VerificationSummary = {
  commandId: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
};

export class VerifiedWorkspaceEditProvider implements CapabilityProvider {
  readonly name = 'workspace.edit.verified';
  #transactions: WorkspaceEditTransactionProvider;
  #commands: ProjectCommandProvider;

  constructor(options: {
    allowedRoots: string[];
    allowedExecutables: string[];
    stateDir: string;
    registryPath?: string;
    windowsPathLeaseExecutable?: string;
  }) {
    this.#transactions = new WorkspaceEditTransactionProvider({
      allowedRoots: options.allowedRoots,
      stateDir: options.stateDir,
      windowsPathLeaseExecutable: options.windowsPathLeaseExecutable
    });
    this.#commands = new ProjectCommandProvider({
      allowedRoots: options.allowedRoots,
      allowedExecutables: options.allowedExecutables,
      registryPath: options.registryPath
    });
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'workspace.edit.verified';
  }

  score(): CapabilityScore {
    return SCORE;
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      if (action.risk !== 'write') {
        throw new OperatorError('VERIFIED_WORKSPACE_EDIT_RISK_MISMATCH', 'workspace.edit.verified requires write risk.');
      }
      const parsed = parseAction(action);
      const commands = await this.#inspectVerifiers(action, parsed.workspaceRoot, parsed.plan, context);
      const editAction = internalEditAction(action, parsed.workspaceRoot, parsed.plan);

      const editResult = await this.#transactions.execute(editAction, context);
      if (!editResult.ok) {
        return remapFailure(action, editResult, started, 'VERIFIED_WORKSPACE_EDIT_APPLY_FAILED');
      }

      const verification: VerificationSummary[] = [];
      for (let index = 0; index < commands.length; index += 1) {
        if (context.signal?.aborted) {
          const rollback = await this.#transactions.rollbackDeferred(editAction);
          return abortedAfterEdit(action, rollback, verification, started);
        }

        const command = commands[index]!;
        const result = await this.#commands.execute({
          id: action.id + ':verify:' + String(index),
          capability: 'project.command.run',
          risk: 'read',
          input: {
            path: parsed.workspaceRoot,
            commandId: command.id,
            expectedRisk: 'read'
          },
          provenance: { kind: 'trusted_policy', source: action.id },
          ...(action.taskId ? { taskId: action.taskId } : {}),
          ...(action.intent ? { intent: action.intent } : {})
        }, context);

        verification.push({
          commandId: command.id,
          ok: result.ok,
          ...(result.error?.code ? { errorCode: result.error.code } : {}),
          durationMs: result.durationMs
        });

        if (!result.ok) {
          const rollback = await this.#transactions.rollbackDeferred(editAction);
          return verifierFailureResult(action, command.id, result, rollback, verification, started);
        }
      }

      const finalized = await this.#transactions.finalizeDeferred(editAction);
      if (!finalized.ok) {
        return {
          ok: false,
          capability: action.capability,
          provider: this.name,
          output: {
            planId: parsed.plan.id,
            verification,
            verificationPassed: true,
            finalizationPassed: false
          },
          evidence: [
            evidence('workspace_edit_verification', 'pass', 'All trusted read-only verification commands passed.', {
              planId: parsed.plan.id,
              commandIds: commands.map((item) => item.id)
            }),
            ...finalized.evidence
          ],
          error: {
            code: finalized.error?.code ?? 'VERIFIED_WORKSPACE_EDIT_FINALIZE_FAILED',
            message: finalized.error?.message ?? 'Verified edit could not finalize durable transaction cleanup.',
            retryable: false,
            sideEffectState: finalized.error?.sideEffectState ?? 'known',
            executionPhase: 'effect_observed'
          },
          durationMs: Math.round(performance.now() - started)
        };
      }

      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: {
          planId: parsed.plan.id,
          verification,
          verificationPassed: true,
          finalizationPassed: true,
          transaction: sanitizedTransactionOutput(finalized.output)
        },
        evidence: [
          evidence('workspace_edit_verification', 'pass', 'All trusted read-only verification commands passed.', {
            planId: parsed.plan.id,
            commandIds: commands.map((item) => item.id)
          }),
          evidence('workspace_edit_verified_commit', 'pass', 'Verified edit transaction finalized only after all required verifiers passed.', {
            planId: parsed.plan.id
          })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('VERIFIED_WORKSPACE_EDIT_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('workspace_edit_verification', 'fail', op.message, { code: op.code })],
        error: {
          code: op.code,
          message: op.message,
          retryable: op.retryable,
          sideEffectState: 'none',
          executionPhase: 'pre_dispatch'
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    request: ProviderReconciliationRequest,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    try {
      const parsed = parseAction(request.action);
      const editAction = internalEditAction(request.action, parsed.workspaceRoot, parsed.plan);
      const transaction = await this.#transactions.reconcile({ action: editAction }, context);
      if (transaction.status === 'not_applied') {
        return {
          status: 'not_applied',
          evidence: [
            evidence('workspace_edit_verified_reconciliation', 'pass', 'Underlying edit transaction is not applied.')
          ]
        };
      }
      if (transaction.status !== 'completed' || !transaction.result) {
        return {
          status: 'uncertain',
          evidence: [
            evidence('workspace_edit_verified_reconciliation', 'info', 'Underlying edit transaction is not conclusively complete.')
          ]
        };
      }

      const output = transaction.result.output as { pendingVerification?: unknown } | undefined;
      if (output?.pendingVerification === true) {
        return {
          status: 'uncertain',
          evidence: [
            evidence(
              'workspace_edit_verified_reconciliation',
              'info',
              'Edit bytes are applied and recoverable, but trusted verification has not been durably finalized. Re-execute the same action to rerun verifiers.'
            )
          ]
        };
      }

      const result: ActionResult = {
        ok: true,
        capability: request.action.capability,
        provider: this.name,
        output: {
          reconciled: true,
          planId: parsed.plan.id,
          transaction: sanitizedTransactionOutput(transaction.result.output)
        },
        evidence: [
          evidence(
            'workspace_edit_verified_reconciliation',
            'pass',
            'Underlying transaction is durably committed, proving prior verification orchestration reached finalization.'
          )
        ],
        durationMs: 0
      };
      return { status: 'completed', result, evidence: result.evidence };
    } catch (error) {
      const code = error instanceof OperatorError ? error.code : 'VERIFIED_WORKSPACE_EDIT_RECONCILIATION_FAILED';
      return {
        status: 'uncertain',
        evidence: [
          evidence('workspace_edit_verified_reconciliation', 'info', 'Verified workspace edit could not be reconciled safely.', { code })
        ]
      };
    }
  }

  async #inspectVerifiers(
    action: ActionRequest,
    workspaceRoot: string,
    plan: MultiFileEditPlan,
    context: CapabilityExecutionContext
  ): Promise<RegisteredCommand[]> {
    const requestedIds = plan.verification.trustedCommandIds;
    if (requestedIds.length < 1) {
      throw new OperatorError(
        'VERIFIED_WORKSPACE_EDIT_VERIFIERS_REQUIRED',
        'workspace.edit.verified requires at least one trusted verifier command in the edit plan.'
      );
    }
    if (requestedIds.length > 50) {
      throw new OperatorError('VERIFIED_WORKSPACE_EDIT_VERIFIERS_INVALID', 'At most 50 verifier commands may be requested.');
    }

    const inspected = await this.#commands.execute({
      id: action.id + ':inspect-verifiers',
      capability: 'project.command.inspect',
      risk: 'read',
      input: { path: workspaceRoot },
      provenance: { kind: 'trusted_policy', source: action.id },
      ...(action.taskId ? { taskId: action.taskId } : {}),
      ...(action.intent ? { intent: action.intent } : {})
    }, context);
    if (!inspected.ok) {
      throw new OperatorError(
        inspected.error?.code ?? 'VERIFIED_WORKSPACE_EDIT_COMMAND_INSPECT_FAILED',
        inspected.error?.message ?? 'Unable to inspect trusted verifier commands.'
      );
    }

    const available = ((inspected.output as { commands?: RegisteredCommand[] } | undefined)?.commands ?? []);
    const byId = new Map(available.map((item) => [item.id, item]));
    return requestedIds.map((id) => {
      const command = byId.get(id);
      if (!command) {
        throw new OperatorError('PROJECT_COMMAND_NOT_REGISTERED', 'Trusted verifier command is not registered: ' + id);
      }
      if (command.risk !== 'read') {
        throw new OperatorError(
          'VERIFIED_WORKSPACE_EDIT_VERIFIER_MUTATING',
          'Verifier commands must be declared read-only: ' + id
        );
      }
      if (command.kind === 'format' || command.kind === 'build' || command.kind === 'dev' || command.kind === 'database') {
        throw new OperatorError(
          'VERIFIED_WORKSPACE_EDIT_VERIFIER_KIND_DENIED',
          'Mutating or long-running command kind is not allowed as an edit verifier: ' + id
        );
      }
      if ((command.artifacts ?? []).some((artifact) => artifact.mustChange === true)) {
        throw new OperatorError(
          'VERIFIED_WORKSPACE_EDIT_VERIFIER_ARTIFACT_MUTATION',
          'Verifier command may not require a changed artifact: ' + id
        );
      }
      return command;
    });
  }
}

function parseAction(action: ActionRequest): { workspaceRoot: string; plan: MultiFileEditPlan } {
  const workspaceRoot = String(action.input.workspaceRoot ?? '');
  if (!workspaceRoot || workspaceRoot.includes('\0')) {
    throw new OperatorError('VERIFIED_WORKSPACE_EDIT_ROOT_REQUIRED', 'workspaceRoot is required.');
  }
  return {
    workspaceRoot,
    plan: validateMultiFileEditPlan(action.input.plan as MultiFileEditPlan)
  };
}

function internalEditAction(
  action: ActionRequest,
  workspaceRoot: string,
  plan: MultiFileEditPlan
): ActionRequest {
  return {
    id: action.id + ':edit',
    capability: 'workspace.edit.transaction',
    risk: 'write',
    input: {
      workspaceRoot,
      plan,
      deferFinalization: true
    },
    provenance: { kind: 'trusted_policy', source: action.id },
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.intent ? { intent: action.intent } : {})
  };
}

function verifierFailureResult(
  action: ActionRequest,
  commandId: string,
  verifier: ActionResult,
  rollback: ActionResult,
  verification: VerificationSummary[],
  started: number
): ActionResult {
  if (rollback.ok) {
    return {
      ok: false,
      capability: action.capability,
      provider: 'workspace.edit.verified',
      output: {
        verification,
        failedCommandId: commandId,
        rollbackPerformed: true
      },
      evidence: [
        evidence('workspace_edit_verification', 'fail', 'Trusted verifier failed; edited files were rolled back.', {
          commandId,
          verifierCode: verifier.error?.code
        }),
        ...rollback.evidence
      ],
      error: {
        code: 'WORKSPACE_EDIT_VERIFICATION_FAILED_ROLLED_BACK',
        message: verifier.error?.message ?? 'Trusted verifier failed.',
        retryable: false,
        sideEffectState: 'none',
        executionPhase: 'effect_observed'
      },
      durationMs: Math.round(performance.now() - started)
    };
  }

  return {
    ok: false,
    capability: action.capability,
    provider: 'workspace.edit.verified',
    output: {
      verification,
      failedCommandId: commandId,
      rollbackPerformed: false
    },
    evidence: [
      evidence('workspace_edit_verification', 'fail', 'Trusted verifier failed and exact rollback could not be proven.', {
        commandId,
        verifierCode: verifier.error?.code,
        rollbackCode: rollback.error?.code
      }),
      ...rollback.evidence
    ],
    error: {
      code: 'WORKSPACE_EDIT_VERIFICATION_FAILED_ROLLBACK_UNCERTAIN',
      message: 'Trusted verifier failed and exact rollback could not be proven.',
      retryable: false,
      sideEffectState: 'uncertain',
      executionPhase: 'effect_observed'
    },
    durationMs: Math.round(performance.now() - started)
  };
}

function abortedAfterEdit(
  action: ActionRequest,
  rollback: ActionResult,
  verification: VerificationSummary[],
  started: number
): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'workspace.edit.verified',
    output: {
      verification,
      rollbackPerformed: rollback.ok
    },
    evidence: [
      evidence(
        'workspace_edit_verification',
        'fail',
        rollback.ok
          ? 'Verification was cancelled; edited files were rolled back.'
          : 'Verification was cancelled and rollback could not be proven.'
      ),
      ...rollback.evidence
    ],
    error: {
      code: rollback.ok ? 'EXECUTION_ABORTED_ROLLED_BACK' : 'EXECUTION_ABORTED_ROLLBACK_UNCERTAIN',
      message: rollback.ok
        ? 'Verified edit was cancelled and rolled back.'
        : 'Verified edit was cancelled and rollback could not be proven.',
      retryable: false,
      sideEffectState: rollback.ok ? 'none' : 'uncertain',
      executionPhase: 'effect_observed'
    },
    durationMs: Math.round(performance.now() - started)
  };
}

function remapFailure(
  action: ActionRequest,
  source: ActionResult,
  started: number,
  fallbackCode: string
): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'workspace.edit.verified',
    output: sanitizedTransactionOutput(source.output),
    evidence: source.evidence,
    error: {
      code: source.error?.code ?? fallbackCode,
      message: source.error?.message ?? 'Workspace edit transaction failed.',
      retryable: false,
      sideEffectState: source.error?.sideEffectState ?? 'uncertain',
      executionPhase: source.error?.executionPhase ?? 'dispatched'
    },
    durationMs: Math.round(performance.now() - started)
  };
}

function sanitizedTransactionOutput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of [
    'planId',
    'workspaceRoot',
    'files',
    'rollbackPerformed',
    'reconciled',
    'pendingVerification'
  ]) {
    if (raw[key] !== undefined) safe[key] = structuredClone(raw[key]);
  }
  return safe;
}
