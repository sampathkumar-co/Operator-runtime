import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTask } from '../src/core/task.ts';
import { projectTaskRuntime } from '../src/core/runtime-projection.ts';
import { buildControlCenterTaskTimeline } from '../src/core/control-center-task-timeline.ts';

function longTask() {
  const task = createTask({
    userObjective: 'Inspect a long-running system history',
    interpretedObjective: 'Inspect prior authorized read results',
    authorizedScope: ['project:demo'],
    prohibitedScope: [],
    successConditions: ['Review evidence'],
    execution: {
      schemaVersion: 1, plannerId: 'fixed', goalKind: 'autonomous-workflow',
      plannerState: {}, maxSteps: 1000, maxAttemptsPerStep: 1, timeoutMs: 90_000,
      stepCount: 620, records: []
    }
  });
  for (let i = 0; i < 620; i++) {
    task.execution!.records.push({
      stepKey: 'step-' + i, actionId: 'action-' + i,
      capability: 'project.inspect', risk: 'read', inputHash: 'a'.repeat(64),
      attempt: 1, state: 'SUCCEEDED',
      startedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      evidence: [{ kind: 'bounded_observation', status: 'pass', message: 'Observed read result',
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }]
    });
  }
  task.failures.push({
    at: new Date(Date.UTC(2026, 9, 1, 0, 0, 20, 500)).toISOString(),
    code: 'OLD_READ_FAILURE', message: 'Prior read failed'
  });
  return task;
}

test('C10 task timeline pages recover all older records without duplicate or invented events', () => {
  const task = longTask();
  const projection = projectTaskRuntime(task);
  const current = buildControlCenterTaskTimeline(task, projection);
  assert.equal(current.timeline.length, 501);
  assert.equal(current.timeline[0]?.kind, 'TASK_CREATED');
  assert.equal(current.page.totalEvents, 621);
  assert.equal(current.page.nextBefore, 121);
  assert.equal(current.truncated, true);
  const older = buildControlCenterTaskTimeline(task, projection, {
    before: current.page.nextBefore!, limit: 100
  });
  assert.equal(older.timeline.length, 100);
  assert.equal(older.page.nextBefore, 21);
  const oldest = buildControlCenterTaskTimeline(task, projection, {
    before: older.page.nextBefore!, limit: 100
  });
  assert.equal(oldest.timeline.length, 21);
  assert.equal(oldest.page.nextBefore, null);
  assert.equal(oldest.truncated, false);
  const all = [...oldest.timeline, ...older.timeline, ...current.timeline.slice(1)];
  assert.equal(all.length, 621);
  assert.equal(new Set(all.map(event => event.id)).size, 621);
  assert.equal(all.filter(event => event.kind === 'TASK_FAILURE').length, 1);
  assert.equal(all[0]?.id, 'action-0');
  assert.equal(all.at(-1)?.id, 'action-619');
  assert.equal(current.evidence.total, 620);
  assert.equal(older.evidence.pass, 620, 'history pagination cannot rewrite total evidence truth');
  assert.equal(older.cost.actual.status, 'NOT_RECORDED');
});

test('C10 invalid or out-of-snapshot history cursor fails closed', () => {
  const task = longTask();
  const projection = projectTaskRuntime(task);
  for (const before of [0, -1, 621.5, Number.NaN, Number.POSITIVE_INFINITY, 622]) {
    assert.throws(() => buildControlCenterTaskTimeline(task, projection, { before }));
  }
  for (const limit of [0, -1, 500.1, 501, Number.NaN]) {
    assert.throws(() => buildControlCenterTaskTimeline(task, projection, { limit }));
  }
});

test('C10 authenticated read-only history UI is source-backed and contains no HTML interpolation', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = await fs.readFile(path.join(root, 'apps/local-agent/src/server.ts'), 'utf8');
  const app = await fs.readFile(path.join(root, 'apps/control-center/src/app.js'), 'utf8');
  const ui = await fs.readFile(path.join(root, 'apps/control-center/src/task-timeline.js'), 'utf8');
  assert.ok(server.includes("requestUrl.searchParams.get('before')"));
  assert.ok(server.includes('TASK_TIMELINE_CURSOR_INVALID'));
  assert.ok(app.includes('"/timeline?before="+before+"&limit=100"'));
  assert.ok(ui.includes('Load earlier actions'));
  assert.ok(ui.includes('document.createDocumentFragment()'));
  assert.equal(ui.includes('innerHTML'), false);
});
