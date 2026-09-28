import { OperatorError } from './errors.ts';
import type { DesiredStateController, DesiredStateContract } from './desired-state.ts';

export interface DesiredStateReconcilerResult {
  inspected: number;
  reconciled: number;
  failed: Array<{ contractId: string; code: string }>;
}

export class DesiredStateReconciler {
  #controller: DesiredStateController;
  #intervalMs: number;
  #maxPerTick: number;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<DesiredStateReconcilerResult> | null = null;
  #stopped = true;
  #onError?: (error: unknown) => void;

  constructor(controller: DesiredStateController, options: { intervalMs?: number; maxPerTick?: number; onError?: (error: unknown) => void } = {}) {
    this.#controller = controller;
    this.#intervalMs = boundedInteger(options.intervalMs ?? 60_000, 1_000, 24 * 60 * 60_000, 'intervalMs');
    this.#maxPerTick = boundedInteger(options.maxPerTick ?? 100, 1, 500, 'maxPerTick');
    this.#onError = options.onError;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#active) {
      try { await this.#active; } catch {}
    }
  }

  async runOnce(): Promise<DesiredStateReconcilerResult> {
    if (this.#active) return await this.#active;
    const run = this.#run();
    this.#active = run;
    try { return await run; }
    finally { if (this.#active === run) this.#active = null; }
  }

  async #run(): Promise<DesiredStateReconcilerResult> {
    const contracts = await this.#controller.list(this.#maxPerTick);
    const failed: Array<{ contractId: string; code: string }> = [];
    let reconciled = 0;
    for (const contract of contracts) {
      if (contract.status === 'PAUSED') continue;
      try {
        await this.#controller.reconcile(contract.id);
        reconciled += 1;
      } catch (error) {
        failed.push({
          contractId: contract.id,
          code: typeof (error as { code?: unknown })?.code === 'string'
            ? String((error as { code: string }).code)
            : 'DESIRED_STATE_RECONCILE_FAILED'
        });
      }
    }
    return { inspected: contracts.length, reconciled, failed };
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      try { await this.runOnce(); }
      catch (error) { this.#onError?.(error); }
      finally { this.#schedule(this.#intervalMs); }
    }, delayMs);
    this.#timer.unref?.();
  }
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError('DESIRED_STATE_RECONCILER_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}
