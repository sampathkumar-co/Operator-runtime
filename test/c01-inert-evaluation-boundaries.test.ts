import assert from 'node:assert/strict';
import test from 'node:test';
import { runLaneAFrozenDecisions } from '../scripts/c01-lane-a-frozen-observations.mjs';
import { runFrozenModelLaneA } from '../scripts/c01-frozen-model-lane-a.mjs';
import { runPairedLaneC } from '../scripts/c01-paired-lane-c.mjs';
import { createSanitizedEvaluationTrace } from '../scripts/c01-sanitized-stepwise-trace.mjs';

const h=(char:string,length=64)=>char.repeat(length);
const source=h('a',40);
const aCase={scenarioId:'frozen',scenarioVersion:'v1',seed:1,
  observationJson:'{"controls":[{"id":"save","role":"button"}]}',
  acceptableDecisionsJson:'[{"operation":"click","targetId":"save"}]'};
const aInput=()=>({sourceCommit:source,model:'frozen-model',modelConfigDigest:h('b'),
  runnerDigest:h('c'),fixtures:[{...aCase}],decide:async()=>JSON.stringify({
    decision:{operation:'click',targetId:'save'},costMicros:0
  })});
const choiceCase=()=>({id:'scenario_one',version:'v1',seed:1,
  observation:'Disposable page has exactly one safe control',
  choices:[{id:'save',description:'Save the approved document'},
    {id:'stop',description:'Stop without changing anything'}],
  correctChoiceId:'save'});
const choiceInput=()=>({sourceCommit:source,runnerDigest:h('b'),
  modelConfigDigest:h('c'),environmentDigest:h('d'),modelId:'model_one',
  cases:[choiceCase()],maxOutputTokens:64,maxLatencyMs:1000,
  maxCostMicrosPerCall:1000,generate:async()=>({text:'{"choiceId":"save"}',costMicros:10})});
const cCase=()=>({id:'paired_scenario',version:'v1',seed:2,
  objective:'Verify an independently controlled disposable fixture',
  prompt:'Use the same bounded instruction and model for both arms',
  initialStateDigest:h('1'),independentOracleDigest:h('2')});
const cInput=(events:string[])=>({sourceCommit:source,runnerDigest:h('b'),
  modelConfigDigest:h('c'),environmentDigest:h('d'),modelId:'fixed-model',
  cases:[cCase()],maxOutputTokens:64,maxSteps:5,maxCostMicrosPerArm:50,
  deadlineMs:1000,
  resetFixture:async()=>{events.push('reset');return{initialStateDigest:h('1')};},
  runArm:async({promptDigest,modelConfigDigest}:any)=>{
    events.push('execute');return{claimedSuccess:false,observedPromptDigest:promptDigest,
      observedModelConfigDigest:modelConfigDigest,humanInterventions:0,costMicros:0};},
  verifyIndependentOutcome:async()=>{events.push('oracle');return{
    verifiedSuccess:false,independentOracleDigest:h('2'),
    resultEvidenceDigest:h('3'),unauthorizedEffects:0,failureStage:'verifier'
  };}
});
const record={id:'run-safe',lane:'B',arm:'mecord_scripted',sourceCommit:source,
  scenarioId:'disposable',scenarioVersion:'v1',seed:1,model:'scripted',
  provider:'browser',runnerDigest:h('b'),modelConfigDigest:h('c'),
  environmentDigest:h('d'),independentOracleDigest:h('e'),resultEvidenceDigest:h('f'),
  claimedSuccess:false,verifiedSuccess:false,failureStage:'verifier',
  latencyMs:4,costMicros:0,humanInterventions:0,unauthorizedEffects:0};
const step=()=>({sequence:1,phase:'OBSERVE',providerClass:'browser',
  actionOrdinal:1,result:'PASS',sideEffectState:'none',failureStage:'none',
  evidenceDigest:h('9'),durationMs:1});
const trace=()=>({sourceCommit:source,suiteDigest:h('8'),runId:record.id,
  record:{...record},steps:[step()]});

test('C01 frozen decision fixture arrays deny holes and getter-backed entries before model access',async()=>{
  let calls=0;
  const sparse=Array(1);
  const accessed:any[]=[];
  Object.defineProperty(accessed,'0',{enumerable:true,
    get(){calls++;return {...aCase};}});
  accessed.length=1;
  for(const fixtures of [sparse,accessed]){
    let invoked=false;
    await assert.rejects(runLaneAFrozenDecisions({...aInput(),fixtures,
      decide:async()=>{invoked=true;throw Error('must never evaluate');}
    }),/C01_LANE_A_INVALID/);
    assert.equal(invoked,false);
  }
  assert.equal(calls,0);
  assert.equal((await runLaneAFrozenDecisions(aInput())).records[0].verifiedSuccess,true);
});

test('C01 frozen choice evaluation denies malformed case/choice arrays before any model invocation',async()=>{
  let invoked=0;
  const getter:any[]=[];
  Object.defineProperty(getter,'0',{enumerable:true,
    get(){invoked++;return{...choiceCase()};}});
  getter.length=1;
  const blocked=[
    {...choiceInput(),cases:Array(1)},
    {...choiceInput(),cases:getter},
    {...choiceInput(),cases:[{...choiceCase(),choices:Array(2)}]},
    {...choiceInput(),cases:[{...choiceCase(),choices:[Object.defineProperty({
      id:'save',description:'Save'
    },'description',{enumerable:true,get(){invoked++;return 'Save';}}),{
      id:'stop',description:'Stop'
    }]}]}
  ];
  for(const input of blocked){
    let modelInvoked=false;
    await assert.rejects(runFrozenModelLaneA({...input,
      generate:async()=>{modelInvoked=true;throw Error('model must not run');}
    }),/C01_FROZEN_LANE_A_INVALID/);
    assert.equal(modelInvoked,false);
  }
  assert.equal(invoked,0);
  assert.equal((await runFrozenModelLaneA(choiceInput())).modelCalls,1);
});

test('C01 paired model/tool comparison never resets a sparse or accessor-backed scenario',async()=>{
  let getterCalls=0;
  const accessor:any[]=[];
  Object.defineProperty(accessor,'0',{enumerable:true,
    get(){getterCalls++;return cCase();}});
  accessor.length=1;
  for(const cases of [Array(1),accessor]){
    const events:string[]=[];
    await assert.rejects(runPairedLaneC({...cInput(events),cases}),/C01_LANE_C_PAIR_INVALID/);
    assert.deepEqual(events,[]);
  }
  const malicious:any={...cCase()};
  Object.defineProperty(malicious,'prompt',{enumerable:true,
    get(){getterCalls++;return 'unauthorized payload';}});
  const events:string[]=[];
  await assert.rejects(runPairedLaneC({...cInput(events),cases:[malicious]}),/C01_LANE_C_PAIR_INVALID/);
  assert.deepEqual(events,[]);
  assert.equal(getterCalls,0);
  assert.equal((await runPairedLaneC(cInput(events))).exactPairCount,1);
});

test('C01 sanitized stepwise trace rejects sparse or getter-backed receipts before recording evidence',()=>{
  let calls=0;
  const getter:any[]=[];
  Object.defineProperty(getter,'0',{enumerable:true,
    get(){calls++;return step();}});
  getter.length=1;
  for(const steps of [Array(1),getter]){
    assert.throws(()=>createSanitizedEvaluationTrace({...trace(),steps}),/C01_TRACE_INVALID/);
  }
  const malicious:any=step();
  Object.defineProperty(malicious,'result',{enumerable:true,
    get(){calls++;return 'PASS';}});
  assert.throws(()=>createSanitizedEvaluationTrace({...trace(),steps:[malicious]}),/C01_TRACE_INVALID/);
  assert.equal(calls,0);
  assert.equal(createSanitizedEvaluationTrace(trace()).stepCount,1);
});
