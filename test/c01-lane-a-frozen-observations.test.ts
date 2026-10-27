import assert from 'node:assert/strict';
import test from 'node:test';
import { runLaneAFrozenDecisions } from '../scripts/c01-lane-a-frozen-observations.mjs';

const sourceCommit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const expected = { operation: 'click', targetId: 'submit' };
function makeCase(overrides: Record<string, unknown> = {}) {
  return {
    scenarioId: 'click_submit', scenarioVersion: 'v1', seed: 42,
    observationJson: JSON.stringify({ controls: [
      { id: 'submit', role: 'button', text: 'Submit' },
      { id: 'cancel', role: 'button', text: 'Cancel' }
    ] }),
    acceptableDecisionsJson: JSON.stringify([expected]),
    ...overrides
  };
}
function config(overrides: Record<string, unknown> = {}) {
  return {
    sourceCommit, model: 'example_model', modelConfigDigest: digest,
    runnerDigest: 'c'.repeat(64), fixtures: [makeCase()],
    decide: async () => JSON.stringify({ decision: expected, costMicros: 0 }),
    ...overrides
  };
}

test('C01 Lane A scores a frozen model-only decision with no Mecord dispatch or physical certification', async () => {
  let calls = 0;
  const observed: unknown[] = [];
  const result = await runLaneAFrozenDecisions(config({
    decide: async (input: any) => {
      calls++;
      assert.deepEqual(Object.keys(input).sort(),
        ['model', 'observation', 'scenarioId', 'scenarioVersion', 'seed', 'signal']);
      assert.ok(Object.isFrozen(input.observation));
      assert.ok(Object.isFrozen(input.observation.controls));
      assert.ok(Object.isFrozen(input.observation.controls[0]));
      assert.equal(input.acceptableDecisionsJson, undefined, 'answer key never sent to callback');
      assert.equal(input.oracleDigest, undefined);
      observed.push(input.observation.controls[0].id);
      return JSON.stringify({ decision: { targetId: 'submit', operation: 'click' }, costMicros: 5 });
    }
  }));
  assert.equal(calls, 1);
  assert.deepEqual(observed, ['submit']);
  assert.equal(result.records[0]?.provider, 'none');
  assert.equal(result.records[0]?.verifiedSuccess, true);
  assert.equal(result.records[0]?.costMicros, 5);
  assert.equal(result.report.lanes.A.status, 'PARTIAL');
  assert.equal(result.report.lanes.A.physicalAcceptance, 'NOT_VERIFIED');
  assert.equal(result.report.lanes.B.status, 'NOT_RUN');
  assert.equal(result.report.lanes.C.status, 'NOT_RUN');
  assert.equal(result.report.releaseAcceptance, 'NOT_ACCEPTED');
  assert.match(result.limitation, /Synthetic caller-supplied/);
});

test('C01 frozen oracle rejects a wrong target even if a model declares it done', async () => {
  const result = await runLaneAFrozenDecisions(config({
    decide: async () => JSON.stringify({ decision: { operation: 'done' }, costMicros: 0 })
  }));
  assert.equal(result.records[0]?.claimedSuccess, true);
  assert.equal(result.records[0]?.verifiedSuccess, false);
  assert.equal(result.records[0]?.failureStage, 'model');
  assert.equal(result.report.lanes.A.evidence.falseCompletions, 1);
});

test('C01 Lane A keeps malformed model output inert and does not run accessor code', async () => {
  let getterCalled = 0;
  const malicious = Object.defineProperty({}, 'operation', {
    enumerable: true, get() { getterCalled++; throw Error('do not execute'); }
  });
  const r = await runLaneAFrozenDecisions(config({
    decide: async () => ({ decision: malicious, costMicros: 0 })
  }));
  assert.equal(getterCalled, 0);
  assert.equal(r.records[0]?.verifiedSuccess, false);
  assert.equal(r.records[0]?.failureStage, 'schema');
});

test('C01 Lane A deadline produces timing failure without dispatch or fabricated model score', async () => {
  let aborted = false;
  const r = await runLaneAFrozenDecisions(config({
    timeoutMs: 25,
    decide: async ({ signal }: any) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return await new Promise(() => {});
    }
  }));
  assert.equal(aborted, true);
  assert.equal(r.records[0]?.failureStage, 'timing');
  assert.equal(r.records[0]?.verifiedSuccess, false);
  assert.equal(r.report.releaseAcceptance, 'NOT_ACCEPTED');
});

test('C01 Lane A rejects duplicated test identities, scripted model labels and extra fixture authority', async () => {
  await assert.rejects(() => runLaneAFrozenDecisions(config({ fixtures: [makeCase(), makeCase()] })),
    /duplicate frozen scenario identity/);
  await assert.rejects(() => runLaneAFrozenDecisions(config({ model: 'scripted' })),
    /named model is required/);
  await assert.rejects(() => runLaneAFrozenDecisions(config({
    fixtures: [makeCase({ authorizedScopes: ['C:\\secrets'] })]
  })), /fixture has extra or executable fields/);
  await assert.rejects(() => runLaneAFrozenDecisions(config({
    fixtures: [makeCase({ acceptableDecisionsJson: JSON.stringify([
      { operation: 'click', targetId: 'submit', capability: 'file.write' }
    ]) })]
  })), /extra fields/);
});

test('C01 Lane A rejects fake JSON prototypes and executable identity on frozen fixture data', async () => {
  const fixture = makeCase();
  Object.defineProperty(fixture, 'observationJson', {
    enumerable: true, get() { throw Error('never run me'); }
  });
  await assert.rejects(() => runLaneAFrozenDecisions(config({ fixtures: [fixture] })),
    /fixture has extra or executable fields/);
  await assert.rejects(() => runLaneAFrozenDecisions(config({
    fixtures: [makeCase({ observationJson: '{"__proto__":{"grants":"all"}}' })]
  })), /valid inert JSON/);
});
