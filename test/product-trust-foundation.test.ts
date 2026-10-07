import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildControlCenterHomeModel } from '../src/core/control-center-model.ts';
import { createDeveloperSession, updateDeveloperSession } from '../src/core/developer-session.ts';
import { OperationTraceStore, summarizeOperationSlo } from '../src/core/operation-trace.ts';

test('Control Center home projection surfaces blockers without exposing internal payloads', () => {
  const base = createDeveloperSession({
    objective: 'Ship verified release',
    acceptanceCriteria: ['Release is independently verified.'],
    workspaceRootNodeId: 'workspace:root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const blocked = updateDeveloperSession(base, { status: 'BLOCKED', resumeSummary: 'Approval required.' }, '2026-10-06T00:01:00.000Z');
  const model = buildControlCenterHomeModel([blocked], { [blocked.id]: 'APPROVAL_REQUIRED' });
  assert.equal(model.counts.blocked, 1);
  assert.equal(model.blockers[0]?.attention, 'APPROVAL_REQUIRED');
  assert.equal('constraints' in model.blockers[0]!, false);
});

test('operation trace is append-only and computes verified SLOs without raw payloads', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-trace-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = new OperationTraceStore(dir);
  const common = {
    traceId: 'trace-1',
    executionContextDigest: 'a'.repeat(64),
    attributes: { capability: 'file.read' }
  };
  await store.append({ ...common, stage: 'REQUEST', outcome: 'OK', at: '2026-10-06T00:00:00.000Z' });
  await store.append({ ...common, stage: 'VERIFY', outcome: 'OK', at: '2026-10-06T00:00:01.000Z' });
  await store.append({ ...common, stage: 'COMPLETE', outcome: 'OK', at: '2026-10-06T00:00:02.000Z' });
  const events = await store.list({ traceId: 'trace-1' });
  assert.equal(events.length, 3);
  const summary = summarizeOperationSlo(events);
  assert.equal(summary.traces, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.falseCompletionCount, 0);
  assert.equal(summary.p50CompletionMs, 2000);
});

test('SLO summary treats completion without verification as false completion', () => {
  const summary = summarizeOperationSlo([
    {
      schemaVersion: 1,
      id: 'event-1',
      traceId: 'trace-1',
      executionContextDigest: 'a'.repeat(64),
      stage: 'REQUEST',
      outcome: 'OK',
      at: '2026-10-06T00:00:00.000Z',
      attributes: {}
    },
    {
      schemaVersion: 1,
      id: 'event-2',
      traceId: 'trace-1',
      executionContextDigest: 'a'.repeat(64),
      stage: 'COMPLETE',
      outcome: 'OK',
      at: '2026-10-06T00:00:01.000Z',
      attributes: {}
    }
  ]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.verified, 0);
  assert.equal(summary.falseCompletionCount, 1);
});
