import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  AdaptiveIntelligenceKernel,
  CausalGraph,
  compressTrajectory,
  pruneHypotheses
} from '../src/index.ts';
import type { BeliefResolution, HypothesisNode, TrajectoryStep } from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function trajectoryStep(index:number):TrajectoryStep{
  const failed=index%7===0;
  return{
    index,
    action:{id:'a'+index,family:failed?'pointer':'semantic',capability:'ui',risk:'write',expectedEffects:['goal.done']},
    outcome:{ok:!failed,sideEffectState:failed?'none':'known',executionPhase:'effect_observed',evidence:[]},
    delta:{
      changedFactKeys:failed?[]:['progress.'+index],
      addedFactKeys:[],removedFactKeys:[],
      expectedEffectsSatisfied:[],expectedEffectsMissing:failed?['goal.done']:[],
      unrelatedEffects:failed?[]:['progress.'+index],
      progressSignals:failed?[]:['advance']
    },
    progress:{
      level:failed?'NONE':'SUBGOAL_PROGRESS',
      confidence:failed?0:0.8,
      creditedSignals:[],rejectedSignals:[],
      goalFactsSatisfied:[],goalFactsMissing:['goal.done'],
      forbiddenFactsObserved:[],verificationRequired:true
    },
    ...(failed?{failure:{
      primary:{class:'ACTION_NO_EFFECT',probability:1,reasons:['synthetic failure'],evidence:[]},
      alternatives:[],entropy:0,evidenceCoverage:0.5
    }}:{})
  };
}

test('10k-step trajectory compression stays bounded and under generous CI latency budget',()=>{
  const steps=Array.from({length:10_000},(_,i)=>trajectoryStep(i));
  const beliefs:BeliefResolution[]=[{
    factKey:'goal.done',status:'UNKNOWN',confidence:0,
    supportingEvidence:[],contradictingEvidence:[],staleEvidence:[],alternatives:[],updatedAt:T0
  }];
  const start=performance.now();
  const compressed=compressTrajectory({
    goal:{id:'g',kind:'long-horizon',objective:'complete long task',successFactKeys:['goal.done']},
    steps,beliefs,maxRecentStrategies:12,maxHypotheses:8,maxEvidence:32
  });
  const elapsed=performance.now()-start;
  assert.ok(elapsed<5000,'compression exceeded 5s budget: '+elapsed+'ms');
  assert.ok(compressed.recentStrategies.length<=12);
  assert.ok(compressed.activeHypotheses.length<=8);
  assert.ok(compressed.criticalEvidence.length<=32);
  assert.equal(compressed.omittedSteps,9988);
});

test('causal graph retains only configured transition window after 10k records',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0),maxTransitions:500});
  const before={id:'b',observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:A,confidence:1,evidence:[]}]};
  const after={id:'a',observedAt:T0,scopeKey:'scene',facts:[{key:'x',valueDigest:B,confidence:1,evidence:[]}]};
  const start=performance.now();
  for(let i=0;i<10_000;i+=1){
    graph.record({
      before:{...before,id:'b'+i},
      action:{id:'action'+i,family:'read',capability:'observe',risk:'read'},
      outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
      after:{...after,id:'a'+i}
    });
  }
  const elapsed=performance.now()-start;
  assert.ok(elapsed<5000,'causal retention exceeded 5s budget: '+elapsed+'ms');
  assert.equal(graph.recent(1000).length,500);
});

test('10k hypotheses prune deterministically to bounded retention',()=>{
  const nodes:HypothesisNode[]=Array.from({length:10_000},(_,i)=>({
    id:'h'+i,
    scope:(['target','action','subgoal','task','environment'] as const)[i%5]!,
    class:'UNKNOWN',
    statement:'hypothesis '+i,
    confidence:(i%100)/100,
    state:i%9===0?'RESOLVED':'ACTIVE',
    evidence:[],contradictingEvidence:[],
    createdAt:T0,
    updatedAt:i%9===0?'2026-10-01T00:00:00.000Z':'2026-10-05T00:00:00.000Z'
  }));
  const start=performance.now();
  const result=pruneHypotheses(nodes,{maxTotal:1000,maxPerScope:250,resolvedTtlMs:60_000},{now:new Date('2026-10-05T01:00:00.000Z')});
  const elapsed=performance.now()-start;
  assert.ok(elapsed<5000,'hypothesis pruning exceeded 5s budget: '+elapsed+'ms');
  assert.ok(result.retained.length<=1000);
  for(const scope of ['target','action','subgoal','task','environment'] as const){
    assert.ok(result.retained.filter(n=>n.scope===scope).length<=250);
  }
});

test('adaptive kernel trajectory retention is hard bounded',()=>{
  const kernel=new AdaptiveIntelligenceKernel({clock:()=>new Date(T0),maxTrajectorySteps:50,maxTransitions:50});
  kernel.observeBelief({factKey:'goal.done',valueDigest:A,polarity:'supports',confidence:0.95,evidence:{digest:A,source:'test',observedAt:T0}});
  for(let i=0;i<200;i+=1){
    kernel.analyzeOutcome({
      goal:{id:'g',kind:'stress',objective:'stress',successFactKeys:['goal.done']},
      before:{id:'b'+i,observedAt:T0,scopeKey:'scene',facts:[]},
      action:{id:'a'+i,family:'observe',capability:'ui.observe',risk:'read'},
      outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
      after:{id:'c'+i,observedAt:T0,scopeKey:'scene',facts:[]},
      relevantFactKeys:['goal.done']
    });
  }
  assert.equal(kernel.trajectory().length,50);
  assert.equal(kernel.causal.recent(1000).length,50);
});
