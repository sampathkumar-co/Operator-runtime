import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { normalizeTraceEvent, type OperationSloSummary, type OperationTraceEvent } from './operation-trace.ts';
import { RELEASE_TRUTH } from './release-truth.ts';
import { OperatorError } from './errors.ts';

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpanJson {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

export interface OtlpTraceExportJson {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpanJson[];
    }>;
  }>;
}

export interface OtlpLogExportJson {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string; version: string };
      logRecords: Array<{
        timeUnixNano: string;
        severityNumber: number;
        severityText: string;
        body: { stringValue: string };
        traceId: string;
        spanId: string;
        attributes: OtlpKeyValue[];
      }>;
    }>;
  }>;
}

export interface OtlpMetricExportJson {
  resourceMetrics: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: Array<{
        name: string;
        unit: string;
        gauge: { dataPoints: Array<{ timeUnixNano: string; asInt?: string; asDouble?: number; attributes: OtlpKeyValue[] }> };
      }>;
    }>;
  }>;
}

const DEFAULT_SAFE_ATTRIBUTE_KEYS = new Set([
  'capability',
  'provider',
  'risk',
  'phase',
  'retryable',
  'sideEffectState',
  'transport',
  'verifier',
  'resourceKind',
  'resultClass'
]);

export function operationTraceToOtlp(
  eventsInput: OperationTraceEvent[],
  options: {
    serviceName?: string;
    environment?: string;
    attributeAllowlist?: string[];
  } = {}
): OtlpTraceExportJson {
  if (!Array.isArray(eventsInput) || eventsInput.length > 100_000) {
    throw invalid('Operation trace export collection is invalid.');
  }

  const events = eventsInput.map(normalizeTraceEvent);
  const byEventId = new Map<string, OperationTraceEvent>();
  for (const event of events) {
    if (byEventId.has(event.id)) throw invalid(`Duplicate operation trace event id: ${event.id}`);
    byEventId.set(event.id, event);
  }
  for (const event of events) {
    if (!event.parentEventId) continue;
    const parent = byEventId.get(event.parentEventId);
    if (parent && parent.traceId !== event.traceId) {
      throw invalid('Operation trace parent cannot cross trace boundaries.');
    }
  }

  const allowlist = options.attributeAllowlist === undefined
    ? DEFAULT_SAFE_ATTRIBUTE_KEYS
    : new Set(options.attributeAllowlist.map(normalizeAttributeKey));

  const spans = events
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at) || a.traceId.localeCompare(b.traceId) || a.id.localeCompare(b.id))
    .map((event) => toSpan(event, allowlist));

  return {
    resourceSpans: [{
      resource: { attributes: resourceAttributes(options) },
      scopeSpans: [{
        scope: {
          name: 'mecord.operation-trace',
          version: RELEASE_TRUTH.product.publicSurfaceVersion
        },
        spans
      }]
    }]
  };
}


export function operationTraceToOtlpLogs(
  eventsInput: OperationTraceEvent[],
  options: { serviceName?: string; environment?: string; attributeAllowlist?: string[] } = {}
): OtlpLogExportJson {
  if (!Array.isArray(eventsInput) || eventsInput.length > 100_000) throw invalid('Operation log export collection is invalid.');
  const allowlist = options.attributeAllowlist === undefined
    ? DEFAULT_SAFE_ATTRIBUTE_KEYS
    : new Set(options.attributeAllowlist.map(normalizeAttributeKey));
  const events = eventsInput.map(normalizeTraceEvent).sort((a,b)=>a.at.localeCompare(b.at)||a.traceId.localeCompare(b.traceId)||a.id.localeCompare(b.id));
  return {
    resourceLogs: [{
      resource: { attributes: resourceAttributes(options) },
      scopeLogs: [{
        scope: { name: 'mecord.operation-log', version: RELEASE_TRUTH.product.publicSurfaceVersion },
        logRecords: events.map((event) => ({
          timeUnixNano: millisToNanos(Date.parse(event.at)),
          severityNumber: logSeverity(event),
          severityText: event.outcome,
          body: { stringValue: `${event.stage}:${event.outcome}` },
          traceId: otelTraceId(event.traceId),
          spanId: otelSpanId(event.id),
          attributes: [
            kv('mecord.stage', event.stage),
            kv('mecord.outcome', event.outcome),
            kv('mecord.execution_context_digest', event.executionContextDigest),
            ...(event.code ? [kv('mecord.code', event.code)] : []),
            ...Object.entries(event.attributes)
              .sort(([a],[b])=>a.localeCompare(b))
              .filter(([key])=>allowlist.has(key))
              .map(([key,value])=>kv(`mecord.attr.${key}`,value))
          ]
        }))
      }]
    }]
  };
}

export function operationSloToOtlpMetrics(
  summary: OperationSloSummary,
  options: { serviceName?: string; environment?: string; at?: string } = {}
): OtlpMetricExportJson {
  if (!summary || !Number.isSafeInteger(summary.traces) || summary.traces < 0) throw invalid('Operation SLO metrics summary is invalid.');
  const at = options.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw invalid('OTLP metric timestamp is invalid.');
  const t = millisToNanos(Date.parse(at));
  const intMetric = (name:string,value:number,unit='1') => ({
    name, unit, gauge: { dataPoints: [{ timeUnixNano: t, asInt: String(safeInteger(value,name)), attributes: [] as OtlpKeyValue[] }] }
  });
  const doubleMetric = (name:string,value:number,unit='1') => ({
    name, unit, gauge: { dataPoints: [{ timeUnixNano: t, asDouble: safeNumber(value,name), attributes: [] as OtlpKeyValue[] }] }
  });
  const metrics = [
    intMetric('mecord.operation.traces',summary.traces),
    intMetric('mecord.operation.completed',summary.completed),
    intMetric('mecord.operation.verified',summary.verified),
    intMetric('mecord.operation.blocked',summary.blocked),
    intMetric('mecord.operation.failed',summary.failed),
    intMetric('mecord.operation.uncertain',summary.uncertain),
    intMetric('mecord.operation.false_completion',summary.falseCompletionCount),
    doubleMetric('mecord.operation.completion_rate',summary.completionRate),
    doubleMetric('mecord.operation.verification_rate',summary.verificationRate),
    doubleMetric('mecord.operation.completion.p50',summary.p50CompletionMs,'ms'),
    doubleMetric('mecord.operation.completion.p95',summary.p95CompletionMs,'ms')
  ];
  return {
    resourceMetrics: [{
      resource: { attributes: resourceAttributes(options) },
      scopeMetrics: [{ scope: { name: 'mecord.operation-metrics', version: RELEASE_TRUTH.product.publicSurfaceVersion }, metrics }]
    }]
  };
}

export function otlpLogExportDigest(payload: OtlpLogExportJson): string {
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export function otlpMetricExportDigest(payload: OtlpMetricExportJson): string {
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export function otlpTraceExportDigest(payload: OtlpTraceExportJson): string {
  if (!payload || !Array.isArray(payload.resourceSpans)) throw invalid('OTLP trace payload is invalid.');
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}


function resourceAttributes(options: { serviceName?: string; environment?: string }): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [
    kv('service.name', bounded(options.serviceName ?? 'mecord-connect', 128, 'serviceName')),
    kv('service.version', RELEASE_TRUTH.product.publicSurfaceVersion),
    kv('mecord.runtime.package.version', RELEASE_TRUTH.source.runtimePackageVersion)
  ];
  if (options.environment !== undefined) attrs.push(kv('deployment.environment.name', bounded(options.environment,128,'environment')));
  return attrs;
}

function logSeverity(event: OperationTraceEvent): number {
  if (event.outcome === 'FAILED') return 17;
  if (event.outcome === 'UNCERTAIN' || event.outcome === 'BLOCKED') return 13;
  if (event.outcome === 'CANCELLED') return 9;
  return 9;
}

function safeInteger(value: unknown, label: string): number {
  const n=Number(value); if(!Number.isSafeInteger(n)||n<0) throw invalid(label+' is invalid.'); return n;
}
function safeNumber(value: unknown, label: string): number {
  const n=Number(value); if(!Number.isFinite(n)||n<0) throw invalid(label+' is invalid.'); return n;
}

function toSpan(event: OperationTraceEvent, allowlist: Set<string>): OtlpSpanJson {
  const endMs = Date.parse(event.at);
  const durationMs = event.durationMs ?? 0;
  const startMs = Math.max(0, endMs - durationMs);

  const attributes: OtlpKeyValue[] = [
    kv('mecord.stage', event.stage),
    kv('mecord.outcome', event.outcome),
    kv('mecord.execution_context_digest', event.executionContextDigest)
  ];
  if (event.code) attributes.push(kv('mecord.code', event.code));
  if (event.durationMs !== undefined) attributes.push(kv('mecord.duration_ms', event.durationMs));

  for (const [key, value] of Object.entries(event.attributes).sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowlist.has(key)) continue;
    attributes.push(kv(`mecord.attr.${key}`, value));
  }

  return {
    traceId: otelTraceId(event.traceId),
    spanId: otelSpanId(event.id),
    ...(event.parentEventId ? { parentSpanId: otelSpanId(event.parentEventId) } : {}),
    name: `mecord.${event.stage.toLocaleLowerCase()}`,
    kind: 1,
    startTimeUnixNano: millisToNanos(startMs),
    endTimeUnixNano: millisToNanos(endMs),
    attributes,
    status: otelStatus(event)
  };
}

function otelStatus(event: OperationTraceEvent): { code: number; message?: string } {
  if (event.outcome === 'OK') return { code: 1 };
  if (event.outcome === 'FAILED') return { code: 2, ...(event.code ? { message: event.code } : {}) };
  return { code: 0, ...(event.code ? { message: event.code } : {}) };
}

function otelTraceId(value: string): string {
  return crypto.createHash('sha256').update(`trace:${value}`, 'utf8').digest('hex').slice(0, 32);
}

function otelSpanId(value: string): string {
  return crypto.createHash('sha256').update(`span:${value}`, 'utf8').digest('hex').slice(0, 16);
}

function millisToNanos(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('Trace timestamp is invalid.');
  return (BigInt(value) * 1_000_000n).toString();
}

function kv(key: string, value: string | number | boolean | null): OtlpKeyValue {
  if (value === null) return { key, value: { stringValue: 'null' } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`OTLP attribute ${key} is not finite.`);
    if (Number.isSafeInteger(value)) return { key, value: { intValue: String(value) } };
    return { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: bounded(value, 1024, key) } };
}

function normalizeAttributeKey(input: unknown): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw invalid('OTLP attribute allowlist contains an invalid key.');
  return value;
}

function bounded(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > maxBytes || input.includes('\0')) {
    throw invalid(`${label} is invalid.`);
  }
  return input;
}

function invalid(message: string): OperatorError {
  return new OperatorError('OTLP_TRACE_EXPORT_INVALID', message);
}
