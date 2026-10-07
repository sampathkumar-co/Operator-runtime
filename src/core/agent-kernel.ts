import crypto from 'node:crypto';
import { actionHash, canonicalJson } from './action-identity.ts';
import { ActionTransitionJournal } from './action-transition-journal.ts';
import { kernelVerificationEvidence, verifyActionOutcome } from './action-verification.ts';
import { evidence } from './evidence.ts';
import { IntentRegistry } from './intent-registry.ts';
import { OperatorError } from './errors.ts';
import { executionContextDigest, executionContextIdentityFrom } from './execution-context-identity.ts';
import type { OperationTraceOutcome, OperationTraceStage } from './operation-trace.ts';
import { OperationTraceStore } from './operation-trace.ts';
import { canonicalResourceKeys, resolvePhysicalResourceKeysForAction, resourceKeysConflict } from './resource-identity.ts';
import type { ResourceLeaseStore } from './resource-leases.ts';
import type { OperatorRuntime } from './runtime.ts';
import type {
  ActionRequest,
  ActionResult,
  CapabilityExecutionContext,
  PermissionProfile,
  ProviderReconciliationResult
} from './types.ts';

export interface AgentKernelExecuteContext extends CapabilityExecutionContext {
  ownerKind?: string;
  ownerId?: string;
  recoveryMode?: 'compensation' | 'reconciliation';
}

export class AgentKernel {
  #runtime: OperatorRuntime;
  #leases: ResourceLeaseStore;
  #journal: ActionTransitionJournal;
  #intents: IntentRegistry;
  #observeResult?: (action: ActionRequest, result: ActionResult) => Promise<void>;
  #beforeProviderDispatch?: (action: ActionRequest, providerName: string, permissions: PermissionProfile) => void | Promise<void>;
  #globalAbortSignal?: () => AbortSignal | undefined;
  #operationTrace?: OperationTraceStore;

  constructor(options: {
    stateDir: string;
    runtime: OperatorRuntime;
    leases: ResourceLeaseStore;
    journal?: ActionTransitionJournal;
    intents?: IntentRegistry;
    observeResult?: (action: ActionRequest, result: ActionResult) => Promise<void>;
    beforeProviderDispatch?: (action: ActionRequest, providerName: string, permissions: PermissionProfile) => void | Promise<void>;
    globalAbortSignal?: () => AbortSignal | undefined;
    operationTrace?: OperationTraceStore;
  }) {
    this.#runtime = options.runtime;
    this.#leases = options.leases;
    this.#journal = options.journal ?? new ActionTransitionJournal(options.stateDir);
    this.#intents = options.intents ?? new IntentRegistry(options.stateDir);
    this.#observeResult = options.observeResult;
    this.#beforeProviderDispatch = options.beforeProviderDispatch;
    this.#globalAbortSignal = options.globalAbortSignal;
    this.#operationTrace = options.operationTrace;
  }

  get journal(): ActionTransitionJournal { return this.#journal; }
  get intents(): IntentRegistry { return this.#intents; }

  async execute(
    action: ActionRequest,
    permissions: PermissionProfile,
    context: AgentKernelExecuteContext = {}
  ): Promise<ActionResult> {
    await this.#trace(action, 'REQUEST', 'OK', { ownerKind: context.ownerKind ?? inferOwnerKind(action) });
    try {
      const result = await this.#executeCore(action, permissions, context);
      await this.#trace(action, 'COMPLETE', traceOutcome(result), {
        provider: result.provider,
        ...(result.error?.code ? { code: result.error.code } : {})
      });
      return result;
    } catch (error) {
      await this.#trace(action, 'COMPLETE', 'FAILED', {
        code: error instanceof OperatorError ? error.code : 'KERNEL_EXECUTION_THROWN'
      });
      throw error;
    }
  }

  async #executeCore(
    action: ActionRequest,
    permissions: PermissionProfile,
    context: AgentKernelExecuteContext = {}
  ): Promise<ActionResult> {
    const ownerKind = bounded(context.ownerKind ?? inferOwnerKind(action), 128);
    const ownerId = bounded(context.ownerId ?? action.taskId ?? action.id, 512);
    const executionSignal = combineAbortSignals(context.signal, this.#globalAbortSignal?.());
    const initialIntentFailure = await this.#intentFailure(action, context.recoveryMode);
    if (initialIntentFailure) return initialIntentFailure;

    try {
      action = (await this.#runtime.authority.authorizeRecovery(
        action,
        permissions,
        (candidate) => this.#runtime.router.resolveRisk(candidate),
        context.authorityToken
      )).canonicalAction;
      await this.#trace(action, 'ROUTE', 'OK', { risk: action.risk });
      await this.#trace(action, 'POLICY', 'OK', { capability: action.capability, risk: action.risk });
    } catch (error) {
      await this.#trace(action, 'POLICY', authorityTraceOutcome(error), { code: traceCode(error), capability: action.capability });
      return authorityFailure(action, error);
    }

    let existing: Awaited<ReturnType<ActionTransitionJournal['inspect']>> | undefined;
    try {
      existing = await this.#journal.inspect(action.id);
    } catch (error) {
      if (!(error instanceof OperatorError) || error.code !== 'ACTION_JOURNAL_NOT_FOUND') throw error;
    }

    const resourceKeys = await resolvePhysicalResourceKeysForAction(action);
    let prepared: Awaited<ReturnType<ActionTransitionJournal['prepare']>>;

    if (!existing) {
      try {
        action = (await this.#runtime.authority.authorize(
          action,
          permissions,
          (candidate) => this.#runtime.router.resolveRisk(candidate),
          context.authorityToken
        )).canonicalAction;
      } catch (error) {
        await this.#trace(action, 'POLICY', authorityTraceOutcome(error), { code: traceCode(error), capability: action.capability });
        const denied = authorityFailure(action, error);
        if (denied.error?.code === 'APPROVAL_REQUIRED') {
          await this.#trace(action, 'APPROVAL', 'BLOCKED', { code: 'APPROVAL_REQUIRED' });
          prepared = await this.#journal.prepare({ action, ownerKind, ownerId, resourceKeys });
          await this.#journal.defer(action.id, denied);
        }
        return denied;
      }
    }

    prepared = await this.#journal.prepare({ action, ownerKind, ownerId, resourceKeys });
    if (action.risk !== 'read') prepared = await this.#journal.recoverPendingCompletion(action.id, action);

    if (prepared.state === 'COMPLETED' && action.risk !== 'read') {
      const replay = await this.#journal.replayCompleted(action.id);
      if (replay) {
        return {
          ...replay,
          evidence: [...replay.evidence, evidence(
            'action_journal_replay',
            'info',
            'Returned the previously completed kernel-verified mutation result without redispatching the provider.'
          )]
        };
      }
      const providerName = [...prepared.transitions].reverse().find((transition) => transition.provider)?.provider;
      if (providerName) {
        const reconciled = await this.reconcile(action, providerName, undefined, context);
        if (reconciled.status === 'completed' && reconciled.result) {
          return {
            ...reconciled.result,
            evidence: [...reconciled.result.evidence, evidence(
              'action_journal_recovered',
              'info',
              'Recovered a completed mutation from provider post-state because its retained replay result was unavailable.'
            )]
          };
        }
      }
      return reconciliationRequired(action, 'A completed mutation is recorded but neither its retained result nor provider post-state can safely reconstruct the outcome.');
    }

    if (action.risk !== 'read' && ['DISPATCHED', 'OBSERVED', 'UNCERTAIN'].includes(prepared.state)) {
      const providerName = [...prepared.transitions].reverse().find((transition) => transition.provider)?.provider;
      if (!providerName) return reconciliationRequired(action, 'A prior mutation dispatch has no provider identity for safe reconciliation.');
      const reconciled = await this.reconcile(action, providerName, undefined, context);
      if (reconciled.status === 'completed' && reconciled.result) return reconciled.result;
      if (reconciled.status !== 'not_applied') {
        return reconciliationRequired(action, 'Provider reconciliation could not prove whether the prior mutation was applied.');
      }
    }

    if (action.risk !== 'read' && prepared.state === 'RECONCILED') {
      const latest = [...prepared.transitions].reverse().find((transition) => transition.reconciliationStatus);
      if (latest?.reconciliationStatus !== 'not_applied') {
        return reconciliationRequired(action, 'Prior mutation reconciliation did not prove a safe redispatch state.');
      }
    }

    if (existing) {
      try {
        action = (await this.#runtime.authority.authorize(
          action,
          permissions,
          (candidate) => this.#runtime.router.resolveRisk(candidate),
          context.authorityToken
        )).canonicalAction;
      } catch (error) {
        const denied = authorityFailure(action, error);
        if (denied.error?.code === 'APPROVAL_REQUIRED' && ['PREPARED', 'DEFERRED'].includes(prepared.state)) {
          await this.#journal.defer(action.id, denied);
        }
        return denied;
      }
    }

    if (action.risk !== 'read') {
      const unresolved = await this.#journal.unresolvedMutations();
      for (const entry of unresolved) {
        if (!entry.resourceKeys.some((left) => resourceKeys.some((right) => resourceKeysConflict(left, right)))) continue;
        await this.#leases.quarantine(entry.actionId, entry.resourceKeys);
      }
    }

    const lease = await this.#leases.acquire(
      `kernel:${ownerKind}:${ownerId}:${crypto.randomUUID()}`,
      resourceKeys,
      action.risk === 'read' ? 'shared' : 'exclusive',
      action.risk === 'read' ? {} : { mutationActionId: action.id }
    );
    await this.#trace(action, 'LEASE', 'OK', { resourceCount: resourceKeys.length, mode: action.risk === 'read' ? 'shared' : 'exclusive' });
    let quarantineArmed = false;
    let retainQuarantine = false;
    try {
      const preDispatchIntentFailure = await this.#intentFailure(action, context.recoveryMode);
      if (preDispatchIntentFailure) return preDispatchIntentFailure;
      if (executionSignal?.aborted) return abortedBeforeDispatch(action);

      let dispatched = false;
      let result = await this.#runtime.execute(action, permissions, {
        ...context,
        ...(executionSignal ? { signal: executionSignal } : {}),
        onProviderDispatch: async (providerName) => {
          await this.#beforeProviderDispatch?.(action, providerName, permissions);
          if (action.risk !== 'read') {
            await this.#leases.quarantine(action.id, resourceKeys);
            quarantineArmed = true;
            retainQuarantine = true;
          }
          await this.#journal.markDispatched(action.id, providerName);
          await this.#trace(action, 'DISPATCH', 'OK', { provider: providerName, capability: action.capability });
          dispatched = true;
          await context.onProviderDispatch?.(providerName);
        }
      });
      let journalEntry = !dispatched && result.error?.executionPhase === 'pre_dispatch'
        ? await this.#journal.defer(action.id, result)
        : await this.#journal.observe(action.id, result);
      if (quarantineArmed) retainQuarantine = journalEntry.state === 'DISPATCHED' || journalEntry.state === 'UNCERTAIN';

      if (!result.ok && action.risk !== 'read' && result.error?.sideEffectState === 'uncertain'
        && result.provider !== 'policy' && result.provider !== 'router') {
        const reconciliation = await this.#runtime.reconcile(action, result.provider, result, {
          ...context,
          ...(executionSignal ? { signal: executionSignal } : {})
        });
        journalEntry = await this.#journal.reconcile(action.id, reconciliation);
        await this.#trace(action, 'RECONCILE', reconciliationTraceOutcome(reconciliation.status), { provider: result.provider, status: reconciliation.status });
        retainQuarantine = journalEntry.state === 'UNCERTAIN';
        result = reconciledResult(action, result, reconciliation);
      }

      result = await this.#publishObservation(action, result);
      if (!result.ok) return result;

      const receipt = verifyActionOutcome({ action, result, journal: journalEntry });
      await this.#trace(action, 'VERIFY', receipt.verified ? 'OK' : 'FAILED', { verifier: 'agent-kernel' });
      if (!receipt.verified) {
        return {
          ok: false,
          capability: action.capability,
          provider: 'agent-kernel',
          evidence: [...result.evidence, kernelVerificationEvidence(receipt)],
          error: {
            code: 'KERNEL_VERIFICATION_FAILED',
            message: 'Agent Kernel could not independently bind the successful provider result to its execution contract.',
            retryable: false,
            sideEffectState: action.risk === 'read' ? 'none' : 'known',
            executionPhase: 'effect_observed'
          },
          durationMs: result.durationMs
        };
      }
      result = { ...result, evidence: [...result.evidence, kernelVerificationEvidence(receipt)] };
      await this.#journal.complete(action.id, receipt.digest, result);
      retainQuarantine = false;
      if (action.intent && !context.recoveryMode) {
        try {
          await this.#intents.assertExecutable(action.intent);
        } catch (error) {
          if (error instanceof Error && 'code' in error && (error as any).code === 'INTENT_STALE') {
            result = {
              ...result,
              evidence: [...result.evidence, evidence(
                'intent_superseded_after_dispatch',
                'info',
                'The action completed under the intent that was current at dispatch; a newer intent now exists, so no later action may reuse this binding.'
              )]
            };
          } else throw error;
        }
      }
      return result;
    } finally {
      try {
        if (quarantineArmed && !retainQuarantine) await this.#leases.clearQuarantine(action.id);
      } finally {
        await lease.release();
      }
    }
  }

  async #trace(
    action: ActionRequest,
    stage: OperationTraceStage,
    outcome: OperationTraceOutcome,
    attributes: Record<string, string | number | boolean | null> = {}
  ): Promise<void> {
    if (!this.#operationTrace) return;
    try {
      await this.#operationTrace.append({
        traceId: action.taskId ?? action.id,
        executionContextDigest: executionContextDigest(executionContextIdentityFrom({
          ...(action.taskId ? { taskId: action.taskId } : {}),
          actionId: action.id,
          ...(action.intent ? { intent: action.intent } : {})
        })),
        stage,
        outcome,
        at: new Date().toISOString(),
        attributes
      });
    } catch {
      // Observability cannot alter execution authority or replay semantics.
    }
  }

  async #intentFailure(
    action: ActionRequest,
    recoveryMode?: AgentKernelExecuteContext['recoveryMode']
  ): Promise<ActionResult | undefined> {
    if (!action.intent || recoveryMode) return undefined;
    try {
      await this.#intents.assertExecutable(action.intent);
      return undefined;
    } catch (error) {
      if (!(error instanceof OperatorError) || (error.code !== 'INTENT_STALE' && error.code !== 'INTENT_NOT_EXECUTABLE')) throw error;
      return {
        ok: false,
        capability: action.capability,
        provider: 'agent-kernel',
        evidence: [evidence('intent_superseded', 'fail', 'A newer conversation intent superseded this action before provider dispatch.', {
          conversationId: action.intent.conversationId,
          intentVersion: action.intent.intentVersion
        })],
        error: {
          code: error.code,
          message: error.code === 'INTENT_STALE'
            ? 'Execution intent is stale and must be rebound to the newest user intent.'
            : error.message,
          retryable: false,
          sideEffectState: 'none',
          executionPhase: 'pre_dispatch'
        },
        durationMs: 0
      };
    }
  }

  async #publishObservation(action: ActionRequest, result: ActionResult): Promise<ActionResult> {
    if (!this.#observeResult) return result;
    try {
      await this.#observeResult(action, result);
      return result;
    } catch (error) {
      const code = error instanceof OperatorError ? error.code : 'PERCEPTION_PUBLICATION_FAILED';
      return {
        ...result,
        evidence: [...result.evidence, evidence(
          'perception_publication',
          'fail',
          'Action result remained authoritative, but the shared perception graph could not ingest its observation.',
          { code }
        )]
      };
    }
  }

  async reconcile(
    action: ActionRequest,
    providerName: string,
    priorResult?: ActionResult,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    const reconciliationSignal = combineAbortSignals(context.signal, this.#globalAbortSignal?.());
    const resourceKeys = await resolvePhysicalResourceKeysForAction(action);
    const existing = await this.#journal.inspect(action.id);
    if (existing.actionDigest !== actionHash(action)
      || canonicalJson(canonicalResourceKeys(existing.resourceKeys)) !== canonicalJson(canonicalResourceKeys(resourceKeys))) {
      throw new OperatorError('ACTION_JOURNAL_ID_CONFLICT', 'Reconciliation action does not match the durable action journal identity.');
    }
    if (!['DISPATCHED', 'OBSERVED', 'UNCERTAIN', 'RECONCILED', 'COMPLETED'].includes(existing.state)) {
      throw new OperatorError('ACTION_RECONCILIATION_NOT_DISPATCHED', 'Only a previously dispatched action can enter provider reconciliation.');
    }
    const recordedProvider = [...existing.transitions].reverse().find((transition) => transition.provider)?.provider;
    if (!recordedProvider || recordedProvider !== providerName) {
      throw new OperatorError('ACTION_RECONCILIATION_PROVIDER_MISMATCH', 'Reconciliation provider must match the provider recorded at dispatch.');
    }

    await this.#leases.quarantine(action.id, resourceKeys);
    const lease = await this.#leases.acquire(
      `kernel-reconcile:${action.id}:${crypto.randomUUID()}`,
      resourceKeys,
      'exclusive',
      { mutationActionId: action.id }
    );
    let retainQuarantine = true;
    try {
      const outcome = await this.#runtime.reconcile(action, providerName, priorResult, {
        ...context,
        ...(reconciliationSignal ? { signal: reconciliationSignal } : {})
      });
      await this.#trace(action, 'RECONCILE', reconciliationTraceOutcome(outcome.status), { provider: providerName, status: outcome.status });
      const journalEntry = existing.state === 'COMPLETED'
        ? existing
        : await this.#journal.reconcile(action.id, outcome);
      if (outcome.status !== 'completed' || !outcome.result) {
        retainQuarantine = outcome.status === 'uncertain';
        return outcome;
      }

      const observedResult = await this.#publishObservation(action, outcome.result);
      const receipt = verifyActionOutcome({ action, result: observedResult, journal: journalEntry });
      if (!receipt.verified) {
        return {
          status: 'uncertain',
          evidence: [...outcome.evidence, kernelVerificationEvidence(receipt)]
        };
      }
      const result = {
        ...observedResult,
        evidence: [...observedResult.evidence, kernelVerificationEvidence(receipt)]
      };
      await this.#journal.complete(action.id, receipt.digest, result);
      retainQuarantine = false;
      return {
        status: 'completed',
        result,
        evidence: [...outcome.evidence, kernelVerificationEvidence(receipt)]
      };
    } finally {
      try {
        if (!retainQuarantine) await this.#leases.clearQuarantine(action.id);
      } finally {
        await lease.release();
      }
    }
  }
}

function traceOutcome(result: ActionResult): OperationTraceOutcome {
  if (result.ok) return 'OK';
  if (result.error?.sideEffectState === 'uncertain') return 'UNCERTAIN';
  if (result.error?.code === 'APPROVAL_REQUIRED' || result.provider === 'policy') return 'BLOCKED';
  if (result.error?.code === 'CANCELLED' || result.error?.code === 'EMERGENCY_STOPPED') return 'CANCELLED';
  return 'FAILED';
}

function authorityTraceOutcome(error: unknown): OperationTraceOutcome {
  return error instanceof OperatorError && error.code === 'APPROVAL_REQUIRED' ? 'BLOCKED' : 'FAILED';
}

function traceCode(error: unknown): string {
  return error instanceof OperatorError ? error.code : 'POLICY_ERROR';
}

function reconciliationTraceOutcome(status: ProviderReconciliationResult['status']): OperationTraceOutcome {
  if (status === 'completed' || status === 'not_applied') return 'OK';
  return 'UNCERTAIN';
}

function reconciledResult(
  action: ActionRequest,
  prior: ActionResult,
  reconciliation: ProviderReconciliationResult
): ActionResult {
  if (reconciliation.status === 'completed' && reconciliation.result) {
    return {
      ...reconciliation.result,
      evidence: [...prior.evidence, ...reconciliation.evidence, ...reconciliation.result.evidence]
    };
  }
  if (reconciliation.status === 'not_applied') {
    return {
      ok: false,
      capability: action.capability,
      provider: prior.provider,
      evidence: [...prior.evidence, ...reconciliation.evidence],
      error: {
        code: 'ACTION_RECONCILED_NOT_APPLIED',
        message: 'Provider reconciliation proved the uncertain action was not applied.',
        retryable: true,
        sideEffectState: 'none',
        executionPhase: 'reconciled'
      },
      durationMs: prior.durationMs
    };
  }
  return {
    ...prior,
    evidence: [...prior.evidence, ...reconciliation.evidence],
    error: {
      ...(prior.error ?? { code: 'ACTION_RECONCILIATION_REQUIRED', message: 'Action outcome remains uncertain.' }),
      retryable: false,
      sideEffectState: 'uncertain',
      executionPhase: 'reconciled'
    }
  };
}

function authorityFailure(action: ActionRequest, error: unknown): ActionResult {
  const op = error instanceof OperatorError
    ? error
    : new OperatorError('POLICY_ERROR', error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    capability: action.capability,
    provider: 'policy',
    evidence: [evidence('policy', 'fail', op.message, { code: op.code })],
    error: {
      code: op.code,
      message: op.message,
      retryable: false,
      sideEffectState: 'none',
      executionPhase: 'pre_dispatch'
    },
    durationMs: 0
  };
}

function reconciliationRequired(action: ActionRequest, message: string): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'agent-kernel',
    evidence: [evidence('reconciliation', 'fail', message)],
    error: {
      code: 'ACTION_RECONCILIATION_REQUIRED',
      message,
      retryable: false,
      sideEffectState: 'uncertain',
      executionPhase: 'reconciled'
    },
    durationMs: 0
  };
}

function abortedBeforeDispatch(action: ActionRequest): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'agent-kernel',
    evidence: [evidence('execution', 'fail', 'Execution was cancelled before dispatch.', { code: 'EXECUTION_ABORTED' })],
    error: {
      code: 'EXECUTION_ABORTED',
      message: 'Execution was cancelled before dispatch.',
      retryable: false,
      sideEffectState: 'none',
      executionPhase: 'pre_dispatch'
    },
    durationMs: 0
  };
}

function combineAbortSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}

function inferOwnerKind(action: ActionRequest): string {
  const source = action.provenance.source ?? '';
  if (source.startsWith('task-planner:')) return 'task';
  if (source.startsWith('studio-workflow:')) return 'studio';
  if (source.startsWith('team:')) return 'team';
  return action.taskId ? 'workload' : 'direct';
}

function bounded(input: string, max: number): string {
  if (input.length < 1 || input.length > max || input.includes('\0')) throw new Error('Agent Kernel owner identity is invalid.');
  return input;
}
