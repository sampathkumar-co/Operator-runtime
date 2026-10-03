import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, ExecutionPhase, PermissionProfile, SideEffectState } from './types.ts';
import { AuthorityKernel } from './authority-kernel.ts';
import { CapabilityRouter } from './router.ts';
import { evidence } from './evidence.ts';
import { OperatorError } from './errors.ts';
import type { ProviderLearning } from './provider-learning.ts';
import { conservativeExecutionPhase, conservativeSideEffectState, retrySafeWithoutReconciliation, validExecutionPhase, validSideEffectState } from './side-effect.ts';

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
      try {
        if (context.signal?.aborted) return abortedResult(canonicalAction, start);
        const result = await provider.execute(canonicalAction, context);
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
        if (context.signal?.aborted || isAbortError(error)) return abortedResult(canonicalAction, start, true);
        const op = error instanceof OperatorError
          ? error
          : new OperatorError('PROVIDER_EXCEPTION', error instanceof Error ? error.message : String(error), { retryable: true });
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

  async close(): Promise<void> {
    await this.router.closeAll();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'The operation was aborted');
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
