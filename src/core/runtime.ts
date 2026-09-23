import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, PermissionProfile } from './types.ts';
import { PolicyEngine } from './policy.ts';
import { CapabilityRouter } from './router.ts';
import { evidence } from './evidence.ts';
import { OperatorError } from './errors.ts';
import { assertCanonicalRisk, capabilityRiskRule } from './capability-policy.ts';
import type { ProviderLearning } from './provider-learning.ts';

export class OperatorRuntime {
  readonly router: CapabilityRouter;
  readonly policy = new PolicyEngine();

  constructor(options: { learning?: ProviderLearning } = {}) {
    this.router = new CapabilityRouter({ learning: options.learning });
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
      this.policy.authorizeBase(action, permissions);
      const rule = capabilityRiskRule(action.capability);
      const canonicalRisk = rule === 'dynamic' ? await this.router.resolveRisk(action) : rule;
      assertCanonicalRisk(action, canonicalRisk);
      canonicalAction = { ...action, risk: canonicalRisk };
      this.policy.authorizeRisk(canonicalAction, permissions);
    } catch (error) {
      const op = error instanceof OperatorError ? error : new OperatorError('POLICY_ERROR', String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: 'policy',
        evidence: [evidence('policy', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: false },
        durationMs: Math.round(performance.now() - start)
      };
    }

    let ranked: Awaited<ReturnType<CapabilityRouter['rank']>>;
    try {
      ranked = await this.router.rank(canonicalAction);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('ROUTING_STATE_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: 'router',
        evidence: [evidence('routing', 'fail', 'Provider ranking failed closed before execution.', { code: op.code })],
        error: { code: op.code, message: op.message, retryable: false },
        durationMs: Math.round(performance.now() - start)
      };
    }
    if (ranked.length === 0) {
      return {
        ok: false,
        capability: action.capability,
        provider: 'router',
        evidence: [evidence('routing', 'fail', `No provider supports ${action.capability}.`)],
        error: { code: 'CAPABILITY_UNAVAILABLE', message: `No provider supports ${action.capability}.`, retryable: false },
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
        failures.push(result.error ?? { code: 'PROVIDER_FAILED', message: `${provider.name} failed.` });
      } catch (error) {
        if (context.signal?.aborted || isAbortError(error)) return abortedResult(canonicalAction, start);
        const op = error instanceof OperatorError
          ? error
          : new OperatorError('PROVIDER_EXCEPTION', error instanceof Error ? error.message : String(error), { retryable: true });
        failures.push({ code: op.code, message: op.message, retryable: op.retryable });
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

function abortedResult(action: ActionRequest, start: number): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider: 'runtime',
    evidence: [evidence('execution', 'fail', 'Execution was cancelled before completion.', { code: 'EXECUTION_ABORTED' })],
    error: { code: 'EXECUTION_ABORTED', message: 'Execution was cancelled before completion.', retryable: false },
    durationMs: Math.round(performance.now() - start)
  };
}
