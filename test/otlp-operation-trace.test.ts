import assert from 'node:assert/strict';
import test from 'node:test';
import {
  operationTraceToOtlp,
  otlpTraceExportDigest
} from '../src/core/otlp-operation-trace.ts';
import type { OperationTraceEvent } from '../src/core/operation-trace.ts';

function event(input: Partial<OperationTraceEvent> & Pick<OperationTraceEvent, 'id' | 'traceId' | 'stage' | 'outcome' | 'at'>): OperationTraceEvent {
  return {
    schemaVersion: 1,
    executionContextDigest: 'a'.repeat(64),
    attributes: {},
    ...input
  };
}

test('OTLP projection emits stable trace/span identifiers and redacts non-allowlisted attributes', () => {
  const payload = operationTraceToOtlp([
    event({
      id: 'event-1',
      traceId: 'trace-1',
      stage: 'REQUEST',
      outcome: 'OK',
      at: '2026-10-06T00:00:00.000Z',
      attributes: {
        capability: 'file.read',
        provider: 'filesystem.native',
        secret: 'must-not-export'
      }
    }),
    event({
      id: 'event-2',
      traceId: 'trace-1',
      parentEventId: 'event-1',
      stage: 'VERIFY',
      outcome: 'OK',
      at: '2026-10-06T00:00:01.000Z',
      durationMs: 25,
      attributes: { verifier: 'runtime' }
    })
  ]);

  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  assert.equal(spans.length, 2);
  assert.match(spans[0]!.traceId, /^[0-9a-f]{32}$/);
  assert.match(spans[0]!.spanId, /^[0-9a-f]{16}$/);
  assert.equal(spans[1]!.parentSpanId, spans[0]!.spanId);

  const keys = spans.flatMap((span) => span.attributes.map((item) => item.key));
  assert.ok(keys.includes('mecord.attr.capability'));
  assert.ok(keys.includes('mecord.attr.provider'));
  assert.equal(keys.includes('mecord.attr.secret'), false);
  assert.equal(JSON.stringify(payload).includes('must-not-export'), false);
});

test('OTLP projection is deterministic regardless of input event order', () => {
  const first = event({
    id: 'e1',
    traceId: 't1',
    stage: 'REQUEST',
    outcome: 'OK',
    at: '2026-10-06T00:00:00.000Z'
  });
  const second = event({
    id: 'e2',
    traceId: 't1',
    stage: 'COMPLETE',
    outcome: 'OK',
    at: '2026-10-06T00:00:01.000Z'
  });

  const left = operationTraceToOtlp([second, first], { environment: 'test' });
  const right = operationTraceToOtlp([first, second], { environment: 'test' });
  assert.deepEqual(left, right);
  assert.equal(otlpTraceExportDigest(left), otlpTraceExportDigest(right));
});

test('failed operations map to OTLP error status while blocked/uncertain remain unset', () => {
  const payload = operationTraceToOtlp([
    event({
      id: 'failed',
      traceId: 'trace-failed',
      stage: 'COMPLETE',
      outcome: 'FAILED',
      code: 'VERIFY_FAILED',
      at: '2026-10-06T00:00:00.000Z'
    }),
    event({
      id: 'uncertain',
      traceId: 'trace-uncertain',
      stage: 'RECONCILE',
      outcome: 'UNCERTAIN',
      code: 'STATE_UNKNOWN',
      at: '2026-10-06T00:00:01.000Z'
    })
  ]);
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  const failed = spans.find((span) => span.name === 'mecord.complete')!;
  const uncertain = spans.find((span) => span.name === 'mecord.reconcile')!;
  assert.equal(failed.status.code, 2);
  assert.equal(failed.status.message, 'VERIFY_FAILED');
  assert.equal(uncertain.status.code, 0);
});

test('OTLP projection rejects duplicate event identities and cross-trace parents', () => {
  const duplicate = event({
    id: 'same',
    traceId: 'trace-1',
    stage: 'REQUEST',
    outcome: 'OK',
    at: '2026-10-06T00:00:00.000Z'
  });
  assert.throws(() => operationTraceToOtlp([duplicate, structuredClone(duplicate)]), /Duplicate operation trace event id/);

  assert.throws(() => operationTraceToOtlp([
    event({
      id: 'parent',
      traceId: 'trace-1',
      stage: 'REQUEST',
      outcome: 'OK',
      at: '2026-10-06T00:00:00.000Z'
    }),
    event({
      id: 'child',
      traceId: 'trace-2',
      parentEventId: 'parent',
      stage: 'VERIFY',
      outcome: 'OK',
      at: '2026-10-06T00:00:01.000Z'
    })
  ]), /cannot cross trace boundaries/);
});

test('explicit attribute allowlist remains bounded and opt-in', () => {
  const payload = operationTraceToOtlp([
    event({
      id: 'event',
      traceId: 'trace',
      stage: 'REQUEST',
      outcome: 'OK',
      at: '2026-10-06T00:00:00.000Z',
      attributes: {
        customClass: 'safe-category',
        capability: 'file.read'
      }
    })
  ], { attributeAllowlist: ['customClass'] });

  const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
  assert.ok(attrs.some((item) => item.key === 'mecord.attr.customClass'));
  assert.equal(attrs.some((item) => item.key === 'mecord.attr.capability'), false);
});
