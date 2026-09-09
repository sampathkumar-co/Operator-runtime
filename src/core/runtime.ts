import type { ActionRequest, ActionResult, CapabilityProvider, PermissionProfile } from './types.ts';
import { PolicyEngine } from './policy.ts';
import { CapabilityRouter } from './router.ts';
import { evidence } from './evidence.ts';
import { OperatorError } from './errors.ts';

export class OperatorRuntime {
  readonly router = new CapabilityRouter();
  readonly policy = new PolicyEngine();

  register(provider: CapabilityProvider): this {
    this.router.register(provider);
    return this;
  }

  async execute(action: ActionRequest, permissions: PermissionProfile): Promise<ActionResult> {
    const start = performance.now();
    try {
      this.policy.authorize(action, permissions);
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

    const ranked = await this.router.rank(action);
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
    for (const { provider, score } of ranked) {
      try {
        const result = await provider.execute(action);
        result.evidence.unshift(evidence('routing', 'info', `Selected ${provider.name}.`, { score }));
        result.durationMs = Math.round(performance.now() - start);
        if (result.ok) return result;
        failures.push(result.error ?? { code: 'PROVIDER_FAILED', message: `${provider.name} failed.` });
      } catch (error) {
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
}
