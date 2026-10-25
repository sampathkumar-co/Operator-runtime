import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/core/action-identity.ts';
import { runFrozenModelDecisionLane } from '../src/core/frozen-model-decision-lane.ts';

const hash = (v: unknown) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const choice = (overrides: Record<string, unknown> = {}) => {
  const observation = { prompt: 'Choose safe action', visible: ['inspect', 'publish'] };
  const expectedActionId = 'inspect';
  return {
    id: 'synthetic_demo', observation, observationSha256: hash(observation),
    allowedActionIds: ['inspect','publish'], expectedActionId,
    oracleSha256: hash({ expectedActionId }), ...overrides
  };
};
const args = (more: Record<string, unknown> = {}) => ({
  sourceCommit: 'a'.repeat(40), modelId: 'fixture_adapter_unverified',
  modelConfigDigest: 'b'.repeat(64), choices: [choice()],
  decide: async () => 'inspect', ...more
});

test('C01 Lane A never exposes oracle answers to the model decision callback', async () => {
  let calls = 0;
  const report = await runFrozenModelDecisionLane(args({
    decide: async (obs: any, allowed: readonly string[], signal: AbortSignal) => {
      calls++;
      assert.equal(obs.prompt, 'Choose safe action');
      assert.deepEqual([...allowed], ['inspect','publish']);
      assert.equal('expectedActionId' in obs, false);
      assert.equal('oracleSha256' in obs, false);
      assert.equal(Object.isFrozen(obs), true);
      assert.equal(Object.isFrozen(allowed), true);
      assert.equal(signal.aborted, false);
      return allowed[0];
    }
  }));
  assert.equal(calls, 1);
  assert.equal(report.oracleMatches, 1);
  assert.equal(report.results[0]?.matchedOracle, true);
  assert.equal(report.mode, 'MODEL_ONLY_NO_MECORD_DISPATCH');
  assert.equal(report.physicalAcceptance, 'NOT_VERIFIED');
  assert.equal(report.releaseAcceptance, 'NOT_ACCEPTED');
  assert.equal(report.reportSha256.length,64);
});

test('C01 wrong choice is model failure, unsupported output is schema failure', async () => {
  const wrong = await runFrozenModelDecisionLane(args({decide:async ()=>'publish'}));
  assert.equal(wrong.oracleMatches,0);
  assert.equal(wrong.results[0]?.failureStage,'none');
  assert.equal(wrong.results[0]?.matchedOracle,false);
  const invalid = await runFrozenModelDecisionLane(args({decide:async ()=>({action:'inspect'})}));
  assert.equal(invalid.oracleMatches,0);
  assert.equal(invalid.results[0]?.failureStage,'schema');
  assert.equal(invalid.results[0]?.proposedActionId,undefined);
});

test('C01 frozen observation and oracle tampering are denied before inference', async () => {
  let called=0;
  const decide = async () => {called++;return 'inspect';};
  for (const altered of [
    choice({observation:{prompt:'different'}}),
    choice({expectedActionId:'publish'}),
    choice({observationSha256:'0'.repeat(64)}),
    choice({oracleSha256:'0'.repeat(64)}),
    choice({allowedActionIds:['inspect','inspect']}),
    choice({allowedActionIds:['inspect']}),
    choice({allowedActionIds:['other','publish']})
  ]) {
    await assert.rejects(
      () => runFrozenModelDecisionLane(args({choices:[altered],decide})),
      (error:any)=>error?.code==='C01_FROZEN_MODEL_LANE_INVALID'
    );
  }
  assert.equal(called,0);
});

test('C01 model rejection and bounded timeout cannot be scored as oracle success', async () => {
  const rejects=await runFrozenModelDecisionLane(args({decide:async()=>{throw Error('failure');}}));
  assert.equal(rejects.results[0]?.failureStage,'model');
  const times=await runFrozenModelDecisionLane(args({
    timeoutMs: 10,
    decide:async()=>new Promise(()=>{})
  }));
  assert.equal(times.results[0]?.failureStage,'timing');
  assert.equal(times.oracleMatches,0);
});

test('C01 rejects forged scripted-model evidence, duplicate suite identities and invalid provenance', async () => {
  const c=choice();
  for(const mutation of [
    {modelId:'scripted'}, {modelId:'none'},
    {sourceCommit:'wrong'}, {modelConfigDigest:'bad'},
    {choices:[c,{...c}]}, {choices:[]}
  ]) {
    await assert.rejects(()=>runFrozenModelDecisionLane(args(mutation)),
      (error:any)=>error?.code==='C01_FROZEN_MODEL_LANE_INVALID');
  }
});
