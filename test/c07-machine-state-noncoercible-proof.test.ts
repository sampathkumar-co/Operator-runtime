import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMachineObservation } from '../src/core/machine-state.ts';
import type { ActionRequest, ActionResult } from '../src/core/types.ts';

function observe(capability: string, output: Record<string, unknown>) {
  const action: ActionRequest = {
    id: 'c07-typed-normalization', capability, risk: 'read',
    input: { path: '/registered' }, provenance: { kind: 'trusted_policy' }
  };
  const result: ActionResult = {
    ok: true, capability, provider: 'synthetic-typed-provider',
    output, durationMs: 1,
    evidence: [{
      kind: 'provider_execution', status: 'pass', message: 'Synthetic provider result',
      timestamp: '2026-10-25T10:00:00.000Z'
    }]
  };
  return normalizeMachineObservation(action, result).importantState;
}

test('C07 only literal numeric command exit codes become trusted machine observations', () => {
  const base = { command: { kind: 'lint' }, validation: { passed: true } };
  assert.equal(observe('project.command.run', { ...base, execution: { exitCode: 0 } }).exitCode, 0);
  for (const corrupt of [null, '0', '', [0], { value: 0 }, false]) {
    const state = observe('project.command.run', { ...base, execution: { exitCode: corrupt } });
    assert.equal('exitCode' in state, false, 'Coerced command exit status must not be persisted');
    assert.equal(state.commandKind, 'lint');
    assert.equal(state.validationPassed, true);
  }
});

test('C07 PostgreSQL proof metadata rejects nonnumeric counts and type-confused columns', () => {
  const base = { profileId: 'local', schema: 'public', table: 'items', rows: [] };
  const actual = observe('postgres.select', {
    ...base, rowCount: 0, limit: 100, offset: 0, columns: ['id', 'note']
  });
  assert.equal(actual.rowCount, 0);
  assert.equal(actual.limit, 100);
  assert.deepEqual(actual.columns, ['id', 'note']);

  const bad = observe('postgres.select', {
    ...base, rowCount: '0', limit: [100], offset: null,
    columns: [['id'], { value: 'note' }, 'real_column']
  });
  for (const field of ['rowCount', 'limit', 'offset']) assert.equal(field in bad, false);
  assert.deepEqual(bad.columns, ['real_column']);
});

test('C07 Docker lifecycle observations refuse nested state and coerced container counts', () => {
  const trusted = observe('docker.inspect', {
    scope: 'project',
    services: [{ service: 'web', containers: 1, states: ['running'] }]
  });
  assert.deepEqual(trusted.services, [{ service: 'web', containers: 1, states: ['running'] }]);

  const nested = observe('docker.inspect', {
    scope: 'project',
    services: [{ service: 'web', containers: 1, states: [['running']] }]
  });
  assert.deepEqual(nested.services, [{ service: 'web', containers: 1, states: [] }]);
  const stringCount = observe('docker.inspect', {
    scope: 'project',
    services: [{ service: 'web', containers: '1', states: ['running'] }]
  });
  assert.equal('services' in stringCount, false);
});
