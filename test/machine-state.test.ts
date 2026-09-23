import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMachineObservation, observationDomain } from '../src/core/machine-state.ts';
import type { ActionRequest, ActionResult } from '../src/core/types.ts';

const provenance = { kind: 'trusted_policy' as const };

function action(capability: string, input: Record<string, unknown>, target?: string): ActionRequest {
  return { id: 'action-test', capability, risk: 'read', input, provenance, ...(target ? { target } : {}) };
}
function result(capability: string, provider: string, output: unknown): ActionResult {
  return {
    ok: true, capability, provider, output, durationMs: 1,
    evidence: [{ kind: 'postcondition', status: 'pass', message: 'verified', timestamp: '2026-09-22T18:00:00.000Z' }]
  };
}

test('normalized machine observation separates semantic domains', () => {
  assert.equal(observationDomain('docker.inspect', 'docker'), 'docker');
  assert.equal(observationDomain('postgres.query', 'postgres.local'), 'database');
  assert.equal(observationDomain('vscode.inspect', 'vscode.cli'), 'ide');
  assert.equal(observationDomain('app.inspect', 'windows.uia'), 'uia');
  assert.equal(observationDomain('browser.inspect', 'browser.cdp'), 'browser');
});
test('normalized observation persists bounded state without raw sensitive inputs', () => {
  const secretValue = 'NeverPersistThisTypedSecret-9271';
  const rawPath = 'C:\\Users\\SAMPATH\\private\\customer-secrets.txt';
  const rawUrl = 'https://example.test/private?token=super-secret-token';
  const request = action('app.operate', {
    operation: 'set_value',
    selector: { automationId: 'password-box', controlType: 'Edit' },
    value: secretValue,
    path: rawPath
  }, rawUrl);
  const output = {
    operation: 'set_value',
    value: secretValue,
    url: rawUrl,
    path: rawPath,
    postcondition: { verified: true, actual_value: secretValue }
  };
  const observation = normalizeMachineObservation(request, result('app.operate', 'windows.uia', output));
  const serialized = JSON.stringify(observation);

  assert.equal(observation.schemaVersion, 2);
  assert.equal(observation.domain, 'uia');
  assert.equal(observation.importantState.operation, 'set_value');
  assert.deepEqual(observation.importantState.postcondition, { verified: true });
  assert.equal(observation.confidence, 1);
  assert.equal(observation.ambiguous, false);
  assert.match(observation.entityId, /^uia:[0-9a-f]{32}$/);
  assert.match(observation.stateVersion, /^[0-9a-f]{64}$/);
  assert.equal(observation.evidenceRefs.length, 1);
  assert.doesNotMatch(serialized, /NeverPersistThisTypedSecret|customer-secrets|super-secret-token/);
});
test('normalized state version is stable for equivalent safe state and changes with important state', () => {
  const request = action('file.read', { path: 'private.txt' });
  const first = normalizeMachineObservation(request, result('file.read', 'filesystem', { sha256: 'a'.repeat(64), bytes: 12, content: 'secret-one' }));
  const equivalent = normalizeMachineObservation(request, result('file.read', 'filesystem', { sha256: 'a'.repeat(64), bytes: 12, content: 'secret-two' }));
  const changed = normalizeMachineObservation(request, result('file.read', 'filesystem', { sha256: 'b'.repeat(64), bytes: 12, content: 'secret-two' }));

  assert.equal(first.entityId, equivalent.entityId);
  assert.equal(first.stateVersion, equivalent.stateVersion);
  assert.notEqual(first.stateVersion, changed.stateVersion);
  assert.equal('content' in first.importantState, false);
});

test('ambiguous provider result is represented explicitly without claiming confidence', () => {
  const request = action('app.inspect', { selector: { name: 'Save' } });
  const failed: ActionResult = {
    ok: false, capability: 'app.inspect', provider: 'windows.uia', evidence: [], durationMs: 1,
    error: { code: 'UIA_AMBIGUOUS_SELECTOR', message: 'more than one control matched', retryable: false }
  };
  const observation = normalizeMachineObservation(request, failed);
  assert.equal(observation.ambiguous, true);
  assert.equal(observation.confidence, 0);
  assert.equal(observation.importantState.errorCode, 'UIA_AMBIGUOUS_SELECTOR');
});
