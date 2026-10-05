import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CausalGraph,
  DecisionTraceLog,
  PromotionLedger,
  createEvaluationFreezeManifest,
  sameEvaluationCandidate,
  verifyEvaluationFreezeManifest
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';
const T1='2026-10-05T00:00:01.000Z';
const T2='2026-10-05T00:00:02.000Z';

function freeze(){
  return createEvaluationFreezeManifest({
    sourceRevision:'a'.repeat(40),
    intelligencePolicyVersion:'p1',
    intelligencePolicyDigest:A,
    adaptiveStateDigest:B,
    authorityPolicyDigest:C,
    procedureSnapshotDigest:D,
    modelProvider:'provider',
    modelId:'model',
    modelConfigDigest:A,
    environmentId:'env',
    environmentDigest:B,
    runnerDigest:C,
    benchmarkId:'suite',
    benchmarkDigest:D,
    seed:0
  },{clock:()=>new Date(T0)});
}

test('evaluation freeze timestamp is record-integrity bound without changing candidate identity semantics',()=>{
  const manifest=freeze();
  assert.equal(verifyEvaluationFreezeManifest(manifest),true);
  assert.match(manifest.recordDigest,/^[0-9a-f]{64}$/);

  const tampered={...manifest,frozenAt:T1};
  assert.equal(verifyEvaluationFreezeManifest(tampered),false);
  assert.equal(sameEvaluationCandidate(manifest,tampered),false);
});

test('decision trace restart rejects evidence metadata tampering even when evidence digest is unchanged',()=>{
  const log=new DecisionTraceLog({clock:()=>new Date(T0)});
  log.append({
    mode:'SHADOW',
    kind:'STRATEGY',
    runId:'run-1',
    taskId:'task-1',
    goalId:'goal-1',
    policyVersion:'p1',
    decisionPointId:'point-1',
    selectedId:'keyboard',
    reason:'reason',
    evidence:[{
      digest:A,
      source:'dom',
      channel:'dom',
      independenceKey:'dom-tree-1',
      observedAt:T0
    }],
    authoritySnapshotDigest:B,
    inputStateDigest:C
  });
  const snapshot=log.snapshot();
  const tampered=structuredClone(snapshot);
  tampered[0]!.evidence[0]!.source='visual';
  assert.throws(()=>DecisionTraceLog.fromSnapshot(tampered),/digest mismatch/);
});

test('promotion ledger restart rejects recordedAt tampering independently of semantic claim replay digest',()=>{
  const ledger=new PromotionLedger({clock:()=>new Date(T0)});
  ledger.record({
    skillId:'skill-1',
    promoted:true,
    reason:'verified',
    verificationDigests:[A],
    policyVersion:'p1',
    sourceRunIds:['run-1']
  },B);
  const snapshot=ledger.snapshot();
  assert.match(snapshot[0]!.entryDigest,/^[0-9a-f]{64}$/);

  const tampered=structuredClone(snapshot);
  tampered[0]!.recordedAt=T1;
  assert.throws(()=>PromotionLedger.fromSnapshot(tampered),/entry digest mismatch/);
});

function state(id:string,evidenceSource:string){
  return{
    id,
    observedAt:T0,
    scopeKey:'scene',
    facts:[{
      key:'x',
      valueDigest:A,
      confidence:1,
      evidence:[{
        digest:B,
        source:evidenceSource,
        channel:'dom',
        independenceKey:'same-evidence',
        observedAt:T0
      }]
    }]
  };
}

test('causal graph rejects evidence digest metadata rebinding across retained transitions',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T1),maxTransitions:10});
  graph.record({
    before:state('b1','dom-source'),
    action:{id:'a1',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:state('c1','dom-source')
  });

  assert.throws(()=>graph.record({
    before:state('b2','different-source'),
    action:{id:'a2',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:state('c2','different-source')
  }),/metadata changed across retained transitions/);
});

test('causal graph restart rejects non-monotonic recordedAt ordering',()=>{
  let clock=T1;
  const graph=new CausalGraph({clock:()=>new Date(clock),maxTransitions:10});
  graph.record({
    before:{id:'b1',observedAt:T0,scopeKey:'scene',facts:[]},
    action:{id:'a1',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c1',observedAt:T0,scopeKey:'scene',facts:[]}
  });
  clock=T2;
  graph.record({
    before:{id:'b2',observedAt:T0,scopeKey:'scene',facts:[]},
    action:{id:'a2',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c2',observedAt:T0,scopeKey:'scene',facts:[]}
  });

  const snapshot=graph.exportState();
  snapshot[1]!.recordedAt=T0;
  assert.throws(()=>CausalGraph.fromState(snapshot),/recordedAt values must be monotonic/);
});

test('causal graph refuses a record timestamp that predates the observed after-state',()=>{
  const graph=new CausalGraph({clock:()=>new Date(T0)});
  assert.throws(()=>graph.record({
    before:{id:'b',observedAt:T0,scopeKey:'scene',facts:[]},
    action:{id:'a',family:'read',capability:'observe',risk:'read'},
    outcome:{ok:true,sideEffectState:'none',executionPhase:'effect_observed',evidence:[]},
    after:{id:'c',observedAt:T1,scopeKey:'scene',facts:[]}
  }),/recordedAt cannot predate/);
});
