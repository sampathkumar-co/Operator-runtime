import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, ExecutionPhase, PermissionProfile, ProviderCapabilitySchema, ProviderReconciliationResult, SideEffectState } from './types.ts';
import { AuthorityKernel } from './authority-kernel.ts';
import { discoverBuiltInCapabilities, type CapabilityDiscoverySnapshot } from './capability-discovery.ts';
import { CapabilityRouter, providerSupports } from './router.ts';
import { evidence } from './evidence.ts';
import { assertProviderResultContract, assertProviderReconciliationContract } from './provider-result-contract.ts';
import { OperatorError } from './errors.ts';
import type { ProviderLearning } from './provider-learning.ts';
import { conservativeExecutionPhase, conservativeSideEffectState, retrySafeWithoutReconciliation, validExecutionPhase, validSideEffectState } from './side-effect.ts';
import { MUTATION_RECONCILIATION_POLICIES, assertRegisteredMutationReconciliation, reconcileFromDurableResult } from './reconciliation-coverage.ts';

export class OperatorRuntime {
  readonly router: CapabilityRouter;
  readonly authority: AuthorityKernel;
  readonly policy: AuthorityKernel['policy'];

  constructor(options: { learning?: ProviderLearning; authority?: AuthorityKernel } = {}) {
    this.router = new CapabilityRouter({ learning: options.learning });
    this.authority = options.authority ?? new AuthorityKernel();
    this.policy = this.authority.policy;
  }

  register(provider: CapabilityProvider): this {
    this.router.register(provider);
    return this;
  }

  async initialize(): Promise<void> {
    await this.router.initializeAll();
  }

  async emergencyStop(): Promise<void> {
    await this.router.emergencyStopAll();
  }

  async assertMutationReconciliationCoverage(): Promise<void> {
    await assertRegisteredMutationReconciliation(this.router.providers());
  }

  async inspectCapabilityDeclarations(): Promise<CapabilityDiscoverySnapshot> {
    return await discoverBuiltInCapabilities(this.router.providers());
  }

  async supportedCapabilities(capabilities: readonly string[]): Promise<string[]> {
    const supported: string[] = [];
    for (const capability of [...new Set(capabilities)].sort()) {
      const action: ActionRequest = {
        id: `capability-probe:${capability}`,
        capability,
        risk: 'read',
        input: {},
        provenance: { kind: 'runtime' }
      };
      if (await this.router.advertises(action)) supported.push(capability);
    }
    return supported;
  }

  async capabilitySchemas(action: ActionRequest): Promise<Array<ProviderCapabilitySchema & { provider: string }>> {
    return await this.router.capabilitySchemas(action);
  }

  async execute(action: ActionRequest, permissions: PermissionProfile, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const start = performance.now();
    if (context.signal?.aborted) return abortedResult(action, start);
    let canonicalAction = action;
    try {
      const decision = await this.authority.authorize(
        action,
        permissions,
        (candidate) => this.router.resolveRisk(candidate),
        context.authorityToken
      );
      canonicalAction = decision.canonicalAction;
    } catch (error) {
      const op = error instanceof OperatorError ? error : new OperatorError('POLICY_ERROR', String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: 'policy',
        evidence: [evidence('policy', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: false, executionPhase: 'pre_dispatch' },
        durationMs: Math.round(performance.now() - start)
      };
    }

    let ranked: Awaited<ReturnType<CapabilityRouter['rank']>>;
    try {
      ranked = await this.router.rank(canonicalAction, context.learningContext ?? 'global');
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('ROUTING_STATE_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: 'router',
        evidence: [evidence('routing', 'fail', 'Provider ranking failed closed before execution.', { code: op.code })],
        error: { code: op.code, message: op.message, retryable: false, executionPhase: 'pre_dispatch' },
        durationMs: Math.round(performance.now() - start)
      };
    }
    if (context.signal?.aborted) return abortedResult(canonicalAction, start);
    if (ranked.length === 0) {
      return {
        ok: false,
        capability: action.capability,
        provider: 'router',
        evidence: [evidence('routing', 'fail', `No provider supports ${action.capability}.`)],
        error: { code: 'CAPABILITY_UNAVAILABLE', message: `No provider supports ${action.capability}.`, retryable: false, executionPhase: 'pre_dispatch' },
        durationMs: Math.round(performance.now() - start)
      };
    }

    const failures = [];
    for (const { provider, score, baseScore, learnedAdjustment } of ranked) {
      // A trusted dispatch callback may veto before the journal moves to
      // DISPATCHED. Never confuse that exact pre-dispatch veto with an abort
      // thrown later by a provider whose effects may already have occurred.
      let trustedPreDispatchAbort = false;
      try {
        if (context.signal?.aborted) return abortedResult(canonicalAction, start);
        if (!await providerSupports(provider, canonicalAction)) {
          failures.push({ code: 'PROVIDER_SUPPORT_CHANGED', message: `${provider.name} no longer supports the canonical action.`, retryable: true, sideEffectState: 'none' as const, executionPhase: 'pre_dispatch' as const });
          continue;
        }
        if (context.signal?.aborted) return abortedResult(canonicalAction, start);
        try {
          const dispatchDecision = await this.authority.authorize(
            canonicalAction,
            permissions,
            async (candidate) => {
              throwIfCancelledBeforeDispatch(context.signal);
              if (!provider.resolveRisk) throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', `Selected provider ${provider.name} has no dynamic-risk contract.`);
              const risk = await provider.resolveRisk(candidate);
              throwIfCancelledBeforeDispatch(context.signal);
              return risk;
            },
            context.authorityToken
          );
          canonicalAction = dispatchDecision.canonicalAction;
        } catch (error) {
          return policyDeniedBeforeDispatch(canonicalAction, error, start);
        }
        if (context.signal?.aborted) return abortedResult(canonicalAction, start);
        try {
          await context.onProviderDispatch?.(provider.name);
        } catch (error) {
          if (error instanceof OperatorError && error.code === 'EXECUTION_ABORTED'
              && error.details?.executionPhase === 'pre_dispatch'
              && error.details?.sideEffectState === 'none') {
            trustedPreDispatchAbort = true;
          }
          throw error;
        }
        // The callback is the durable dispatch linearization point for AgentKernel.
        // Cancellation after it cannot prove that no provider effect began, even
        // when this runtime has not yet invoked provider.execute.
        if (context.signal?.aborted) return abortedResult(canonicalAction, start, true);
        const result = assertProviderResultContract(
          await provider.execute(canonicalAction, context), canonicalAction, provider.name
        );
        result.evidence.unshift(evidence('routing', 'info', `Selected ${provider.name}.`, { score, baseScore, learnedAdjustment }));
        result.durationMs = Math.round(performance.now() - start);
        if (result.ok) return result;
        const executionPhase = conservativeExecutionPhase(result);
        const sideEffectState = conservativeSideEffectState(canonicalAction.risk, result);
        const failure = {
          ...(result.error ?? { code: 'PROVIDER_FAILED', message: `${provider.name} failed.` }),
          sideEffectState,
          executionPhase
        };
        failures.push(failure);
        if (canonicalAction.risk !== 'read'
          && (failure.retryable !== true || !retrySafeWithoutReconciliation(canonicalAction.risk, sideEffectState))) {
          return { ...result, error: failure };
        }
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) {
          return abortedResult(canonicalAction, start, !trustedPreDispatchAbort);
        }
        const op = error instanceof OperatorError
          ? error
          : new OperatorError('PROVIDER_EXCEPTION', 'Provider execution failed.', { retryable: true });
        const executionPhase = thrownExecutionPhase(op);
        const sideEffectState = executionPhase === 'pre_dispatch' ? 'none' : thrownSideEffectState(canonicalAction.risk, op);
        const failure = { code: op.code, message: op.message, retryable: op.retryable, sideEffectState, executionPhase };
        failures.push(failure);
        if (canonicalAction.risk !== 'read'
          && (op.retryable !== true || !retrySafeWithoutReconciliation(canonicalAction.risk, sideEffectState))) {
          return {
            ok: false,
            capability: canonicalAction.capability,
            provider: provider.name,
            evidence: [evidence('routing', 'info', `Selected ${provider.name}.`, { score, baseScore, learnedAdjustment }),
              evidence('execution', 'fail', op.message, { code: op.code, sideEffectState })],
            error: failure,
            durationMs: Math.round(performance.now() - start)
          };
        }
        if (!op.retryable) break;
      }
    }

    const last = failures.at(-1) ?? { code: 'EXECUTION_FAILED', message: 'Execution failed.' };
    return {
      ok: false,
      capability: action.capability,
      provider: ranked[0].provider.name,
      evidence: [evidence('execution', 'fail', last.message, { failures })],
      error: last,
      durationMs: Math.round(performance.now() - start)
    };
  }

  async reconcile(
    action: ActionRequest,
    providerName: string,
    priorResult?: ActionResult,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    if (context.signal?.aborted) return cancelledReconciliation(providerName, 'before provider selection');
    const provider = await this.router.provider(providerName);
    let supported = false;
    try {
      supported = provider ? await providerSupports(provider, action) : false;
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) {
        return cancelledReconciliation(providerName, 'while provider support was being revalidated');
      }
      throw error;
    }
    if (context.signal?.aborted) return cancelledReconciliation(providerName, 'after provider support revalidation');
    if (!provider || !supported) {
      throw new OperatorError('PROVIDER_RECONCILIATION_UNAVAILABLE', `Provider ${providerName} is not available for reconciliation.`);
    }
    if (!provider.reconcile) {
      const policy = MUTATION_RECONCILIATION_POLICIES[action.capability];
      if (policy?.mode === 'side_effect_free') return assertProviderReconciliationContract(
        reconcileFromDurableResult(providerName, action.capability, priorResult), action, providerName
      );
      throw new OperatorError('PROVIDER_RECONCILIATION_CONTRACT_MISSING', `Provider ${providerName} has no reconciliation contract for mutable capability ${action.capability}.`);
    }
    try {
      const outcome = await provider.reconcile({ action, ...(priorResult ? { priorResult } : {}) }, context);
      if (context.signal?.aborted) return cancelledReconciliation(providerName, 'while provider reconciliation was in progress');
      return assertProviderReconciliationContract(outcome, action, providerName);
    } catch (error) {
      if (context.signal?.aborted || isAbortError(error)) {
        return cancelledReconciliation(providerName, 'while provider reconciliation was in progress');
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.router.closeAll();
  }
}

function policyDeniedBeforeDispatch(action: ActionRequest, error: unknown, start: number): ActionResult {
  const op = error instanceof OperatorError ? error : new OperatorError('POLICY_ERROR', String(error));
  return {
    ok: false,
    capability: action.capability,
    provider: 'policy',
    evidence: [evidence('policy_dispatch', 'fail', 'Authority changed or could not be revalidated immediately before provider dispatch.', { code: op.code })],
    error: { code: op.code, message: op.message, retryable: false, sideEffectState: 'none', executionPhase: 'pre_dispatch' },
    durationMs: Math.round(performance.now() - start)
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'The operation was aborted');
}

function throwIfCancelledBeforeDispatch(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new OperatorError('EXECUTION_ABORTED', 'Execution authority was cancelled before provider dispatch.', {
    retryable: false,
    details: { sideEffectState: 'none', executionPhase: 'pre_dispatch' }
  });
}

function cancelledReconciliation(providerName: string, boundary: string): ProviderReconciliationResult {
  return {
    status: 'uncertain',
    evidence: [evidence(
      'reconciliation_cancelled',
      'fail',
      'Provider reconciliation was cancelled; the prior side effect remains uncertain.',
      { code: 'EXECUTION_ABORTED', provider: providerName, boundary }
    )]
  };
}

function thrownExecutionPhase(error: OperatorError): ExecutionPhase {
  try {
    if (error.details?.executionPhase !== undefined) return validExecutionPhase(error.details.executionPhase);
  } catch {
    // Malformed exception metadata cannot prove that dispatch was avoided.
  }
  return 'dispatched';
}

function thrownSideEffectState(risk: ActionRequest['risk'], error: OperatorError): SideEffectState {
  if (risk === 'read') return 'none';
  try {
    if (error.details?.sideEffectState !== undefined) return validSideEffectState(error.details.sideEffectState);
  } catch {
    // Malformed exception metadata cannot prove that dispatch was side-effect free.
  }
  return 'uncertain';
}

function abortedResult(action: ActionRequest, start: number, afterDispatch = false): ActionResult {
  const executionPhase: ExecutionPhase = afterDispatch ? 'dispatched' : 'pre_dispatch';
  const sideEffectState = action.risk === 'read' || executionPhase === 'pre_dispatch' ? 'none' : 'uncertain';
  return {
    ok: false,
    capability: action.capability,
    provider: 'runtime',
    evidence: [evidence('execution', 'fail', 'Execution was cancelled before completion.', { code: 'EXECUTION_ABORTED' })],
    error: { code: 'EXECUTION_ABORTED', message: 'Execution was cancelled before completion.', retryable: false, sideEffectState, executionPhase },
    durationMs: Math.round(performance.now() - start)
  };
}
