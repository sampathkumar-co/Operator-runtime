import {
  normalizeTraceEvent,
  type OperationTraceEvent,
  type OperationTraceStage
} from './operation-trace.ts';
import { OperatorError } from './errors.ts';

/**
 * Read-only attribution of elapsed time between consecutive trusted trace
 * stages. Never infer CPU/provider/model cost from the size of an interval.
 * Incomplete traces remain separate from completed latency percentiles.
 */
export interface OperationStageLatency {
  stage: OperationTraceStage;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface OperationLatencyBreakdown {
  traces: number;
  terminalTraces: number;
  incompleteTraces: number;
  invalidCausalTraces: number;
  p50EndToEndMs: number;
  p95EndToEndMs: number;
  p99EndToEndMs: number;
  stages: OperationStageLatency[];
}

const MAX_EVENTS = 100_000;
const MAX_SAMPLES = 100_000;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
}

function positiveDuration(from: OperationTraceEvent, to: OperationTraceEvent): number | undefined {
  const elapsed = Date.parse(to.at) - Date.parse(from.at);
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

/**
 * Completion latency is measurable only when REQUEST is followed by COMPLETE
 * within a single immutable execution-context digest. Repeated or incomplete
 * request events cannot fabricate a second successful completion sample.
 */
export function summarizeOperationStageLatency(eventsInput: OperationTraceEvent[]): OperationLatencyBreakdown {
  if (!Array.isArray(eventsInput) || eventsInput.length > MAX_EVENTS) {
    throw new OperatorError('OPERATION_LATENCY_INVALID', 'Operation latency sample exceeds the event boundary.');
  }
  const grouped = new Map<string, OperationTraceEvent[]>();
  for (const input of eventsInput) {
    const event = normalizeTraceEvent(input);
    const bucket = grouped.get(event.traceId) ?? [];
    bucket.push(event);
    grouped.set(event.traceId, bucket);
  }
  const fullDurations: number[] = [];
  const stageDurations = new Map<OperationTraceStage, number[]>();
  let invalidCausalTraces = 0;
  let incompleteTraces = 0;
  for (const raw of grouped.values()) {
    const sorted = raw.slice().sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const requested = sorted.filter(event => event.stage === 'REQUEST');
    const terminal = sorted.filter(event => event.stage === 'COMPLETE');
    // One trace represents one request and one terminal event; if the owner
    // crosses context/scope or duplicates terminal claims, never count success.
    if (requested.length !== 1 || terminal.length > 1 ||
      sorted.some(event => event.executionContextDigest !== sorted[0]!.executionContextDigest) ||
      new Set(sorted.map(event => event.id)).size !== sorted.length) {
      invalidCausalTraces++;
      continue;
    }
    if (terminal.length === 0) {
      incompleteTraces++;
      continue;
    }
    const first = requested[0]!;
    const last = terminal[0]!;
    if (sorted[0] !== first || sorted.at(-1) !== last) {
      invalidCausalTraces++;
      continue;
    }
    const elapsed = positiveDuration(first, last);
    if (elapsed === undefined) {
      invalidCausalTraces++;
      continue;
    }
    fullDurations.push(elapsed);
    for (let i = 1; i < sorted.length; i++) {
      const prior = sorted[i - 1]!;
      const next = sorted[i]!;
      const duration = positiveDuration(prior, next);
      if (duration === undefined) continue;
      const stage = next.stage;
      const samples = stageDurations.get(stage) ?? [];
      if (samples.length < MAX_SAMPLES) samples.push(duration);
      stageDurations.set(stage, samples);
    }
  }
  fullDurations.sort((a,b) => a - b);
  const stages = [...stageDurations.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([stage, samples]) => {
    samples.sort((a,b) => a - b);
    return {
      stage, samples: samples.length,
      p50Ms: percentile(samples, .5),
      p95Ms: percentile(samples, .95),
      p99Ms: percentile(samples, .99),
      maxMs: samples.at(-1) ?? 0
    };
  });
  return {
    traces: grouped.size, terminalTraces: fullDurations.length,
    incompleteTraces, invalidCausalTraces,
    p50EndToEndMs: percentile(fullDurations, .5),
    p95EndToEndMs: percentile(fullDurations, .95),
    p99EndToEndMs: percentile(fullDurations, .99),
    stages
  };
}
