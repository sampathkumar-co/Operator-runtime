import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CausalGraph,
  EpistemicStateEngine,
  deriveDelta,
  selectStrategy
} from '../src/index.ts';
import type { StateSnapshot, StrategyCandidate } from '../src/index.ts';

const DIGESTS='abcdef0123456789';
const T0='2026-10-05T00:00:00.000Z';

function prng(seed:number){
  let state=seed>>>0;
  return()=>{state=(1664525*state+1013904223)>>>0; return state/0x1_0000_0000;};
}
function digest(index:number):string{
  const ch=DIGESTS[index%DIGESTS.length]!;
  return ch.repeat(64);
}
function snapshot(id:string,facts:Record<string,string>):StateSnapshot{
  return{
    id,observedAt:T0,scopeKey:'synthetic:fuzz',
    facts:Object.entries(facts).sort(([a],[b])=>a.localeCompare(b)).map(([key,valueDigest])=>({
      key,valueDigest,confidence:1,evidence:[{digest:valueDigest,source:'fuzz',observedAt:T0}]
    }))
  };
}

test('500 fuzzed irrelevant mutations can never satisfy an untouched expected effect',()=>{
  const random=prng(0x5eed1234);
  for(let caseIndex=0;caseIndex<500;caseIndex+=1){
    const goal='goal.'+Math.floor(random()*20);
    const base=digest(caseIndex);
    const beforeFacts:Record<string,string>={[goal]:base};
    const afterFacts:Record<string,string>={[goal]:base};
    const noiseCount=1+Math.floor(random()*20);
    for(let i=0;i<noiseCount;i+=1){
      const key='noise.'+caseIndex+'.'+i;
      if(random()>0.5) beforeFacts[key]=digest(i+1);
      afterFacts[key]=digest(i+2+caseIndex);
    }
    const delta=deriveDelta(snapshot('b'+caseIndex,beforeFacts),snapshot('a'+caseIndex,afterFacts),[goal],[]);
    assert.deepEqual(delta.expectedEffectsSatisfied,[]);
    assert.deepEqual(delta.expectedEffectsMissing,[goal]);
  }
});

test('fuzzed target labels do not defeat semantic repeated-failure detection',()=>{
  const random=prng(0x12345678);
  for(let trial=0;trial<100;trial+=1){
    const graph=new CausalGraph({clock:()=>new Date(T0)});
    const effect='goal.effect.'+trial;
    for(let i=0;i<2;i+=1){
      const label='target-'+Math.floor(random()*1_000_000);
      graph.record({
        before:snapshot('b'+trial+'-'+i,{[effect]:digest(trial)}),
        action:{
          id:'a'+trial+'-'+i,
          family:'pointer-activation',
          capability:'ui.interact',
          risk:'write',
          semanticTarget:label,
          expectedEffects:[effect]
        },
        outcome:{ok:false,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
        after:snapshot('c'+trial+'-'+i,{[effect]:digest(trial)})
      });
    }
    const candidates:StrategyCandidate[]=[
      {
        id:'repeat',family:'pointer-activation',description:'repeat same family',
        expectedSuccess:0.84,expectedCost:1,uncertainty:0.1,verificationStrength:0.8,expectedEffects:[effect]
      },
      {
        id:'different',family:'semantic-keyboard',description:'materially different family',
        expectedSuccess:0.72,expectedCost:1,uncertainty:0.1,verificationStrength:0.8,expectedEffects:[effect]
      }
    ];
    assert.equal(selectStrategy({candidates,recentTransitions:graph.recent(10).reverse()}).selected.id,'different');
  }
});

test('epistemic resolution is insertion-order invariant for equivalent independent evidence',()=>{
  const observations=[
    {factKey:'target.state',valueDigest:digest(1),polarity:'supports' as const,confidence:0.8,evidence:{digest:digest(2),source:'dom',observedAt:T0}},
    {factKey:'target.state',valueDigest:digest(1),polarity:'supports' as const,confidence:0.7,evidence:{digest:digest(3),source:'uia',observedAt:T0}},
    {factKey:'target.state',valueDigest:digest(4),polarity:'contradicts' as const,confidence:0.2,evidence:{digest:digest(5),source:'visual',observedAt:T0}}
  ];
  const one=new EpistemicStateEngine({clock:()=>new Date(T0)});
  const two=new EpistemicStateEngine({clock:()=>new Date(T0)});
  for(const obs of observations) one.observe(obs);
  for(const obs of [...observations].reverse()) two.observe(obs);
  const a=one.resolve('target.state'),b=two.resolve('target.state');
  assert.equal(a.status,b.status);
  assert.equal(a.selectedValueDigest,b.selectedValueDigest);
  assert.ok(Math.abs(a.confidence-b.confidence)<1e-12);
});
