import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createTask } from '../src/core/task.ts';
import { verifyGoalOutcomeTruth } from '../src/core/task-verifier.ts';
import { postgresSelectActionInput } from '../src/core/semantic-task-input.ts';
import { canonicalJson } from '../src/core/action-identity.ts';

function makeGoal(goal: Record<string, unknown>) {
  return createTask({
    userObjective: 'Read registered database rows',
    interpretedObjective: 'Read bounded rows from the authorized table',
    authorizedScope: ['test-root'], prohibitedScope: [],
    successConditions: ['Matching bounded rows were inspected'],
    execution: {
      schemaVersion: 1, plannerId: 'operator.semantic.v1',
      goalKind: 'postgres-select', plannerState: { phase: 'complete', goal },
      maxSteps: 4, maxAttemptsPerStep: 1, timeoutMs: 30000,
      stepCount: 0, records: []
    }
  });
}

test('C07 PostgreSQL verifier rejects nonprimitive goal fields without coercion', () => {
  const base = {
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    schema: 'public', table: 'items', columns: ['id'], limit: 25,
    offset: 0, timeoutMs: 5000
  };
  let coercions = 0;
  const malicious = { toString() { coercions++; return 'items'; }, valueOf() { coercions++; return 25; } };
  const mutations: Record<string, unknown>[] = [
    { table: ['items'] }, { table: malicious }, { profileId: malicious },
    { root: malicious }, { schema: malicious }, { columns: [['id']] },
    { columns: [malicious] }, { limit: '25' }, { limit: malicious },
    { offset: [0] }, { timeoutMs: '5000' }, { timeoutMs: Number.NaN },
    { limit: -1 }, { limit: Number.POSITIVE_INFINITY },
    { filters: malicious }, { orderBy: malicious }
  ];
  for (const changes of mutations) {
    const outcome = verifyGoalOutcomeTruth(makeGoal({ ...base, ...changes }));
    assert.equal(outcome.supported, true);
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /malformed input types/);
  }
  assert.equal(coercions, 0, 'Verifier must not invoke untrusted conversion methods');
});

test('C07 PostgreSQL verifier preserves valid typed inputs for independent evidence evaluation', () => {
  const result = verifyGoalOutcomeTruth(makeGoal({
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    table: 'items', columns: ['id'], limit: 25, offset: 0, timeoutMs: 5000
  }));
  assert.equal(result.supported, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /result evidence does not match/);
});


test('C07 PostgreSQL result evidence must use literal machine-observed rows, limits and columns', () => {
  const goal = {
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    schema: 'public', table: 'items', columns: ['id'], limit: 25,
    offset: 0, timeoutMs: 5000
  };
  const task = makeGoal(goal);
  const input = postgresSelectActionInput({
    root: goal.root, profileId: goal.profileId, schema: goal.schema,
    table: goal.table, columns: goal.columns, filters: [], orderBy: [],
    limit: goal.limit, offset: goal.offset, timeoutMs: goal.timeoutMs
  });
  const inputHash = crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
  const observedState: Record<string, unknown> = {
    profileId: 'local', schema: 'public', table: 'items',
    limit: 25, offset: 0, rowCount: 1, columns: ['id']
  };
  task.execution!.records.push({
    stepKey: 'select-postgres-rows', actionId: 'observed-select',
    capability: 'postgres.select', risk: 'read', inputHash,
    attempt: 0, state: 'SUCCEEDED',
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:00.200Z',
    evidence: [],
    observation: {
      schemaVersion: 2, channel: 'semantic', domain: 'database',
      provider: 'synthetic', capability: 'postgres.select', entityId: 'database:fixture',
      observedAt: '2026-10-26T10:00:00.100Z',
      stateVersion: 'a'.repeat(64), importantState: observedState,
      epistemicStatus: 'KNOWN', epistemicReason: '', ambiguous: false,
      confidence: 1, evidenceRefs: ['b'.repeat(64)]
    }
  });
  assert.equal(verifyGoalOutcomeTruth(task).ok, true, 'genuine bounded numeric result still verifies');

  let calls = 0;
  const coercedOne = { valueOf() { calls++; return 1; }, toString() { calls++; return '1'; } };
  const coercedId = { toString() { calls++; return 'id'; } };
  const invalidStates = [
    { rowCount: '1' }, { rowCount: coercedOne },
    { limit: '25' }, { limit: coercedOne }, { offset: '0' },
    { offset: [0] }, { columns: [coercedId] },
    { columns: [['id']] }, { columns: Array(1) }
  ];
  for (const change of invalidStates) {
    Object.assign(observedState, { profileId: 'local', schema: 'public', table: 'items',
      limit: 25, offset: 0, rowCount: 1, columns: ['id'] }, change);
    assert.equal(verifyGoalOutcomeTruth(task).ok, false,
      'coerced or sparse database observations must not verify the SELECT');
  }
  const getterColumns: unknown[] = [];
  Object.defineProperty(getterColumns, '0', {
    enumerable: true, get() { calls++; return 'id'; }
  });
  getterColumns.length = 1;
  observedState.columns = getterColumns;
  assert.equal(verifyGoalOutcomeTruth(task).ok, false,
    'an accessor-backed column entry is not trustworthy');
  assert.equal(calls, 0, 'no untrusted valueOf, toString or getter may execute');
});


test('C07 PostgreSQL SELECT proof requires completed known read from matching capability', () => {
  const goal = { kind: 'postgres-select', root: '/registered', profileId: 'local',
    schema: 'public', table: 'items', columns: ['id'], limit: 25,
    offset: 0, timeoutMs: 5000 };
  const task = makeGoal(goal);
  const input = postgresSelectActionInput({ root: goal.root, profileId: goal.profileId,
    schema: goal.schema, table: goal.table, columns: goal.columns, filters: [],
    orderBy: [], limit: goal.limit, offset: goal.offset, timeoutMs: goal.timeoutMs });
  const inputHash = crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
  task.execution!.records.push({
    stepKey: 'select-postgres-rows', actionId: 'causal-select', capability: 'postgres.select',
    risk: 'read', inputHash, attempt: 0, state: 'SUCCEEDED',
    startedAt: '2026-10-26T10:00:00.000Z', finishedAt: '2026-10-26T10:00:00.200Z',
    evidence: [],
    observation: {
      schemaVersion: 2, channel: 'semantic', domain: 'database',
      provider: 'synthetic', capability: 'postgres.select', entityId: 'database:fixture',
      observedAt: '2026-10-26T10:00:00.100Z', stateVersion: 'a'.repeat(64),
      importantState: { profileId: 'local', schema: 'public', table: 'items',
        limit: 25, offset: 0, rowCount: 1, columns: ['id'] },
      epistemicStatus: 'KNOWN', epistemicReason: '', ambiguous: false,
      confidence: 1, evidenceRefs: ['b'.repeat(64)]
    }
  });
  const valid = structuredClone(task.execution!.records[0]!);
  assert.equal(verifyGoalOutcomeTruth(task).ok, true);
  const mutations: Array<(record: typeof valid) => void> = [
    record => { record.risk = 'write'; },
    record => { record.capability = 'project.inspect'; },
    record => { record.startedAt = '2026-10-26T10:00:00.150Z'; },
    record => { record.finishedAt = '2026-10-26T10:00:00.050Z'; },
    record => { record.finishedAt = undefined; },
    record => { if (record.observation?.schemaVersion === 2) {
      record.observation.capability = 'file.info';
    } },
    record => { if (record.observation?.schemaVersion === 2) {
      record.observation.epistemicStatus = 'UNKNOWN';
    } },
    record => { if (record.observation?.schemaVersion === 2) {
      record.observation.ambiguous = true;
    } }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const broken = structuredClone(valid);
    mutate(broken);
    task.execution!.records = [broken];
    assert.equal(verifyGoalOutcomeTruth(task).ok, false,
      'malformed independent DB read receipt case ' + index);
  }
  task.execution!.records = [valid];
  assert.equal(verifyGoalOutcomeTruth(task).ok, true,
    'only completed known matching SELECT read can verify data');
});


test('C07 SQL goal arrays must be dense own-data structures without executable accessors', () => {
  const base = {
    kind: 'postgres-select', root: '/registered', profileId: 'local',
    schema: 'public', table: 'items', columns: ['id'], limit: 25,
    offset: 0, timeoutMs: 5000
  };
  let getterCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true, get() { getterCalls++; return 'id'; }
  });
  accessorArray.length = 1;
  const nested: Record<string, unknown> = { field: 'id' };
  Object.defineProperty(nested, 'op', {
    enumerable: true, get() { getterCalls++; return 'eq'; }
  });
  const extra = ['id'] as any;
  extra.every = () => { getterCalls++; return true; };
  const cases: Array<Record<string, unknown>> = [
    { columns: Array(1) }, { columns: accessorArray },
    { columns: extra }, { filters: Array(1) },
    { orderBy: Array(1) }, { filters: [nested] },
    { orderBy: [new Date()] }, { columns: new Array(101).fill('id') }
  ];
  for (const [index, delta] of cases.entries()) {
    const verdict = verifyGoalOutcomeTruth(makeGoal({ ...base, ...delta }));
    assert.equal(verdict.supported, true);
    assert.equal(verdict.ok, false, 'malformed SQL goal array case ' + index);
    assert.match(verdict.detail, /malformed input types/);
  }
  const getterGoal: Record<string, unknown> = { ...base };
  Object.defineProperty(getterGoal, 'columns', {
    enumerable: true, get() { getterCalls++; return ['id']; }
  });
  const verdict = verifyGoalOutcomeTruth(makeGoal(getterGoal));
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /malformed input types/);
  assert.equal(getterCalls, 0, 'PostgreSQL goal validation must not invoke hooks');

  const valid = verifyGoalOutcomeTruth(makeGoal({
    ...base, filters: [{ field: 'id', op: 'eq', value: 'A' }],
    orderBy: [{ field: 'id', direction: 'asc' }]
  }));
  assert.equal(valid.supported, true);
  assert.equal(valid.ok, false);
  assert.match(valid.detail, /result evidence does not match/,
    'normal literal object operands remain supported');
});
