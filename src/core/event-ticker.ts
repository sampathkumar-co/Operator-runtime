import { OperatorError } from './errors.ts';
import type { DurableEventRuntime } from './event-runtime.ts';

export interface DurableEventTickerResult {
  woke: string[];
  timedOut: string[];
}

export class DurableEventTicker {
  #events: DurableEventRuntime;
  #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<DurableEventTickerResult> | null = null;
  #stopped = true;

  constructor(events: DurableEventRuntime, options: { intervalMs?: number } = {}) {
    this.#events = events;
    this.#intervalMs = boundedInteger(options.intervalMs ?? 1_000, 250, 60_000, 'intervalMs');
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

  async runOnce(): Promise<DurableEventTickerResult> {
    if (this.#active) return await this.#active;
    const run = this.#events.tick();
    this.#active = run;
    try { return await run; }
    finally { if (this.#active === run) this.#active = null; }
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(async () => {
      this.#timer = null;
      try { await this.runOnce(); }
      finally { this.#schedule(this.#intervalMs); }
    }, delayMs);
    this.#timer.unref?.();
  }
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError('EVENT_TICKER_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}
