import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// Per-process secret prevents dictionary recovery of low-entropy task references.
// Cross-host correlation is deliberately not inferred from these local spans.
const TRACE_KEY = crypto.randomBytes(32);

export const PIPELINE_STAGES = [
  'hosted.ingress_auth', 'hosted.validation_serialization', 'relay.queue',
  'relay.queue_wait', 'relay.result_wait', 'relay.result_commit', 'relay.dispatch', 'relay.network_to_device',
  'local.request_processing', 'local.authorization_approval', 'local.journal_audit',
  'local.resource_lease', 'local.capability_routing', 'browser.target_discovery',
  'browser.cdp_connection', 'browser.cdp_roundtrip', 'browser.operation',
  'browser.dom_postcondition', 'kernel.verify_complete',
  'relay.result_transport', 'hosted.response_serialization',
  'hosted.relay_roundtrip', 'unobservable_gap'
] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];
export type PipelineOrigin = 'hosted-mcp' | 'relay-server' | 'local-agent' | 'browser' | 'benchmark';
export type PipelineResult = 'ok' | 'failed';

export interface PipelineSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  stage: PipelineStage;
  origin: PipelineOrigin;
  startTime: string;
  durationMs: number;
  result: PipelineResult;
}
export interface PipelineSummary {
  stage: PipelineStage;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Stable-in-process opaque hash. Never returns a raw action or principal ID. */
export function opaqueTraceId(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 512) {
    throw new Error('Pipeline trace correlation identifier must be a bounded string.');
  }
  return crypto.createHmac('sha256', TRACE_KEY).update('mecord.pipeline.v1\0').update(value).digest('hex');
}
function capacity(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 8192) {
    throw new Error('Pipeline latency recorder capacity must be between 1 and 8192.');
  }
  return raw;
}
function stage(raw: string): PipelineStage {
  if (!(PIPELINE_STAGES as readonly string[]).includes(raw)) {
    throw new Error('Unrecognized pipeline stage cannot enter telemetry.');
  }
  return raw as PipelineStage;
}
function origin(raw: string): PipelineOrigin {
  if (!['hosted-mcp','relay-server','local-agent','browser','benchmark'].includes(raw)) {
    throw new Error('Unrecognized pipeline origin cannot enter telemetry.');
  }
  return raw as PipelineOrigin;
}
function quantile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

/**
 * Explicitly constructed, OFF by default. No process environment, network,
 * timers, background exports or file I/O. Spans contain CLOSED ENUM metadata,
 * opaque IDs and monotonic durations only, never payloads or error messages.
 */
export class PipelineLatencyRecorder {
  readonly enabled: boolean;
  readonly capacity: number;
  readonly #slots: Array<PipelineSpan | undefined>;
  readonly #scope = new AsyncLocalStorage<{ traceId: string; spanId: string }>();
  #cursor = 0;
  #size = 0;
  #dropped = 0;

  constructor(options: { enabled?: boolean; capacity?: number } = {}) {
    this.enabled = options.enabled === true;
    this.capacity = capacity(options.capacity ?? 1024);
    this.#slots = new Array(this.capacity);
  }
  get droppedSpans(): number { return this.#dropped; }
  snapshot(): PipelineSpan[] {
    const offset = this.#size === this.capacity ? this.#cursor : 0;
    const out: PipelineSpan[] = [];
    for (let i = 0; i < this.#size; i++) {
      const span = this.#slots[(offset + i) % this.capacity];
      if (span) out.push({ ...span });
    }
    return out;
  }
  async measure<T>(
    info: { stage: PipelineStage; origin: PipelineOrigin; traceId?: string },
    action: () => T | Promise<T>,
    classifySuccess?: (value: T) => boolean
  ): Promise<T> {
    if (!this.enabled) return await action();
    const checkedStage = stage(info.stage);
    const checkedOrigin = origin(info.origin);
    const parent = this.#scope.getStore();
    const traceId = info.traceId === undefined ? parent?.traceId ?? crypto.randomUUID()
      : opaqueTraceId(info.traceId);
    const parentSpanId = parent?.traceId === traceId ? parent.spanId : undefined;
    const spanId = crypto.randomUUID();
    const startTime = new Date().toISOString();
    const started = performance.now();
    let result: PipelineResult = 'ok';
    try {
      const value = await this.#scope.run({ traceId, spanId }, action);
      if (classifySuccess) {
        // A missing result can be a normal API return but is not a fulfilled
        // stage. Classification is observation only: never change the value
        // or turn a successful action into a thrown telemetry exception.
        try {
          if (classifySuccess(value) !== true) result = 'failed';
        } catch {
          result = 'failed';
        }
      }
      return value;
    } catch (error) {
      result = 'failed';
      throw error;
    } finally {
      const durationMs = Math.max(0, performance.now() - started);
      const entry: PipelineSpan = {
        traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
        stage: checkedStage, origin: checkedOrigin, startTime,
        durationMs: Number.isFinite(durationMs) ? durationMs : 0, result
      };
      if (this.#size === this.capacity) this.#dropped++;
      else this.#size++;
      this.#slots[this.#cursor] = entry;
      this.#cursor = (this.#cursor + 1) % this.capacity;
    }
  }
  summarize(): PipelineSummary[] {
    const byStage = new Map<PipelineStage, number[]>();
    for (const span of this.snapshot()) {
      const values = byStage.get(span.stage) ?? [];
      values.push(span.durationMs);
      byStage.set(span.stage, values);
    }
    return [...byStage.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,values])=>{
      values.sort((a,b)=>a-b);
      return { stage:key, count:values.length, p50Ms:quantile(values,.50),
        p95Ms:quantile(values,.95), maxMs:values.at(-1) ?? 0 };
    });
  }
}
