import assert from 'node:assert/strict';
import test from 'node:test';
import { compareMatchedPerformance } from '../scripts/c09-compare-performance.mjs';
const hash = v => v.repeat(64);
function row(id, timings) {
  return {
    scenarioId:id, seed: 1, arm:'mecord', modelVersion:'v1',
    endToEndMs:200, stageTimingsMs:timings,
    claimedSuccess:true,verifiedSuccess:true,humanInterventions:0,
    unauthorizedOperations:0,uncertainReplays:0,costMicros:0
  };
}
function campaign(sourceCommit, records) {
  return {sourceCommit,fixtureDigest:hash('1'),modelConfigDigest:hash('2'),
    controllerDigest:hash('3'),authorizationDigest:hash('4'),
    scorerDigest:hash('5'),environmentDigest:hash('6'),records};
}
test('C09 bottleneck report chooses largest observed stage p95 and never emits journey identities',()=>{
  const data=[
    row('private_checkout_customer_1',{provider:110,relay:20}),
    row('private_checkout_customer_2',{provider:125,relay:25})
  ];
  const result=compareMatchedPerformance({
    baseline:campaign('a'.repeat(40),data),
    candidate:campaign('b'.repeat(40),data)
  });
  assert.deepEqual(result.bottleneck,{
    stage:'provider',stageP95Ms:125,stageObservedJourneys:2,
    matchedJourneys:2,evidenceCoverage:'PARTIAL',proof:'SELF_REPORTED_STAGE_TIMINGS'
  });
  assert.equal(JSON.stringify(result).includes('private_checkout'),false);
  assert.equal(result.releaseAcceptance,'NOT_ACCEPTED');
});
test('C09 complete stage coverage is labeled without claiming independent proof',()=>{
  const all={mcpEdge:1,relay:2,journal:3,authority:4,
    provider:10,verification:5,resultCommit:1,model:40};
  const rows=[row('safe_1',all),row('safe_2',all)];
  const result=compareMatchedPerformance({
    baseline:campaign('a'.repeat(40),rows),
    candidate:campaign('b'.repeat(40),rows)
  });
  assert.equal(result.bottleneck.stage,'model');
  assert.equal(result.bottleneck.stageP95Ms,40);
  assert.equal(result.bottleneck.evidenceCoverage,'COMPLETE');
  assert.equal(result.bottleneck.proof,'SELF_REPORTED_STAGE_TIMINGS');
});
