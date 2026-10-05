import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CausalGraph,
  assessShadowAdoption,
  buildTrajectoryIntegrityChain,
  verifyTrajectoryIntegrityChain
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function makeTransition(index:number){
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  return graph.record({
    before:{id:'b'+index,observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:A,confidence:1,evidence:[]}]},
    action:{id:'a'+index,family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c'+index,observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:B,confidence:1,evidence:[]}]}
  });
}

test('trajectory integrity chain verifies untampered history and detects payload mutation',()=>{
  const transitions=[makeTransition(1),makeTransition(2),makeTransition(3)];
  const chain=buildTrajectoryIntegrityChain(transitions);
  assert.deepEqual(verifyTrajectoryIntegrityChain(transitions,chain),{ok:true,checked:3});

  const tampered=structuredClone(transitions);
  tampered[1]!.action.family='write';
  const result=verifyTrajectoryIntegrityChain(tampered,chain);
  assert.equal(result.ok,false);
  assert.equal(result.firstInvalidSequence,1);
  assert.match(result.reason??'',/digest mismatch/);
});

test('trajectory integrity chain detects reorder and record-link tampering',()=>{
  const transitions=[makeTransition(1),makeTransition(2),makeTransition(3)];
  const chain=buildTrajectoryIntegrityChain(transitions);
  const reordered=[transitions[1]!,transitions[0]!,transitions[2]!];
  assert.equal(verifyTrajectoryIntegrityChain(reordered,chain).ok,false);

  const badChain=structuredClone(chain);
  badChain[2]!.priorRecordDigest='f'.repeat(64);
  const result=verifyTrajectoryIntegrityChain(transitions,badChain);
  assert.equal(result.ok,false);
  assert.equal(result.firstInvalidSequence,2);
});

test('shadow adoption fails closed until evidence thresholds are satisfied',()=>{
  const blocked=assessShadowAdoption({
    pairedDecisions:20,
    agreementRate:0.5,
    divergenceRate:0.5,
    shadowWinRate:0.2,
    controlWinRate:0.1,
    tiedOutcomeRate:0.7,
    meanShadowProgressDelta:0.1,
    meanShadowCostDelta:0,
    unmatchedShadow:0,
    unmatchedControl:0
  },{
    taskCount:20,
    firstStrategySuccessRate:0.6,
    recoverySuccessRate:0.8,
    falseGoalProgressRate:0,
    repeatedEquivalentFailureRate:0.02,
    averageStepsPerTask:2
  });
  assert.equal(blocked.eligible,false);
  assert.ok(blocked.blockers.includes('paired-decisions'));

  const eligible=assessShadowAdoption({
    pairedDecisions:500,
    agreementRate:0.6,
    divergenceRate:0.4,
    shadowWinRate:0.2,
    controlWinRate:0.05,
    tiedOutcomeRate:0.75,
    meanShadowProgressDelta:0.08,
    meanShadowCostDelta:-0.1,
    unmatchedShadow:0,
    unmatchedControl:0
  },{
    taskCount:500,
    firstStrategySuccessRate:0.75,
    recoverySuccessRate:0.8,
    falseGoalProgressRate:0.002,
    repeatedEquivalentFailureRate:0.02,
    averageStepsPerTask:2
  });
  assert.equal(eligible.eligible,true);
  assert.deepEqual(eligible.blockers,[]);
});

test('shadow adoption blocks false-progress or loop regression even if shadow wins more often',()=>{
  const result=assessShadowAdoption({
    pairedDecisions:500,
    agreementRate:0.4,
    divergenceRate:0.6,
    shadowWinRate:0.3,
    controlWinRate:0.05,
    tiedOutcomeRate:0.65,
    meanShadowProgressDelta:0.2,
    meanShadowCostDelta:-0.2,
    unmatchedShadow:0,
    unmatchedControl:0
  },{
    taskCount:500,
    firstStrategySuccessRate:0.8,
    recoverySuccessRate:0.9,
    falseGoalProgressRate:0.08,
    repeatedEquivalentFailureRate:0.2,
    averageStepsPerTask:2
  });
  assert.equal(result.eligible,false);
  assert.ok(result.blockers.includes('false-goal-progress-rate'));
  assert.ok(result.blockers.includes('repeated-equivalent-failure-rate'));
});
