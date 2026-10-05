import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LearningFirewall,
  assessOutcomeContract,
  assessPolicyPromotion,
  computeIntelligenceMetrics,
  selectRecovery
} from '../src/index.ts';
import type {
  FailureAttribution,
  IntelligenceMetrics,
  PolicyPromotionCriteria,
  RecoveryOption,
  ShadowComparisonReport,
  SkillDraft,
  TrajectoryStep
} from '../src/index.ts';

const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),D='d'.repeat(64);
const T0='2026-10-05T00:00:00.000Z';

function attribution(cls:FailureAttribution['primary']['class']):FailureAttribution{
  return{
    primary:{class:cls,probability:1,reasons:['synthetic'],evidence:[]},
    alternatives:[],
    entropy:0,
    evidenceCoverage:1
  };
}
function option(kind:RecoveryOption['kind']):RecoveryOption{
  return{
    id:kind.toLowerCase(),
    kind,
    description:kind,
    expectedInformationGain:0.5,
    expectedSuccess:0.8,
    expectedCost:1,
    risk:kind==='FAIL_SAFE'?0:0.2,
    resolvesHypotheses:['UNKNOWN']
  };
}

test('authority denial cannot fall through into adaptive repair when FAIL_SAFE is absent',()=>{
  assert.throws(()=>selectRecovery({
    attribution:attribution('AUTHORITY_DENIED'),
    options:[option('REPAIR'),option('REPLAN')]
  }),/Fail-safe recovery is mandatory/);
});

test('uncertain mutation cannot fall through into retry when RECONCILE is absent',()=>{
  assert.throws(()=>selectRecovery({
    attribution:attribution('SIDE_EFFECT_UNCERTAIN'),
    options:[option('REPAIR'),option('REPLAN')]
  }),/Reconciliation recovery is mandatory/);
});

function genericSkill(overrides:Partial<SkillDraft>={}):SkillDraft{
  return{
    id:'generic-hierarchy',
    objectiveKind:'navigate-hierarchy',
    title:'Navigate a dynamic hierarchy',
    scopeClass:'authorized-ui',
    assumptions:['semantic observation available'],
    steps:[{
      actionFamily:'discover-descendants',
      capability:'ui.observe',
      preconditions:['parent visible'],
      expectedEffects:['child visible'],
      verificationFacts:['child actionable']
    }],
    verificationDigests:[A],
    sourceRunIds:['run-1'],
    ...overrides
  };
}

test('declared benchmark/evaluation lineage blocks generic skill promotion even if text is generic',()=>{
  const firewall=new LearningFirewall();
  const result=firewall.evaluate({
    skill:genericSkill({benchmarkIdentifiers:['held-out-evaluation-case']}),
    mode:'NORMAL',
    policyVersion:'p1',
    independentlyVerified:true
  });
  assert.equal(result.promoted,false);
  assert.match(result.reason,/lineage is declared/);
});

test('fresh contradictory evidence cannot refresh stale positive proof',()=>{
  const result=assessOutcomeContract({
    id:'proof',
    required:[{
      factKey:'document.saved',
      minConfidence:0.9,
      maxEvidenceAgeMs:1000
    }]
  },[{
    factKey:'document.saved',
    status:'KNOWN',
    confidence:0.99,
    selectedValueDigest:A,
    supportingEvidence:[{
      digest:A,
      source:'old-positive',
      channel:'dom',
      observedAt:'2026-10-05T00:00:00.000Z',
      independenceKey:'old-positive'
    }],
    contradictingEvidence:[{
      digest:B,
      source:'fresh-negative',
      channel:'uia',
      observedAt:'2026-10-05T00:00:10.000Z',
      independenceKey:'fresh-negative'
    }],
    staleEvidence:[],
    alternatives:[{valueDigest:A,confidence:0.99}],
    updatedAt:'2026-10-05T00:00:10.000Z'
  }],{now:new Date('2026-10-05T00:00:10.000Z')});
  assert.equal(result.ok,false);
  assert.match(result.checks[0]!.reason,/positive supporting evidence is fresh enough/);
});

test('correlated positive evidence cannot satisfy independent-source proof threshold',()=>{
  const result=assessOutcomeContract({
    id:'proof',
    required:[{
      factKey:'document.saved',
      minConfidence:0.9,
      minIndependentSources:2
    }]
  },[{
    factKey:'document.saved',
    status:'KNOWN',
    confidence:0.99,
    selectedValueDigest:A,
    supportingEvidence:[
      {digest:A,source:'dom-derived',channel:'dom',observedAt:T0,independenceKey:'same-capture'},
      {digest:B,source:'vision-derived',channel:'visual',observedAt:T0,independenceKey:'same-capture'}
    ],
    contradictingEvidence:[],
    staleEvidence:[],
    alternatives:[{valueDigest:A,confidence:0.99}],
    updatedAt:T0
  }],{now:new Date(T0)});
  assert.equal(result.ok,false);
  assert.match(result.checks[0]!.reason,/Independent supporting evidence count/);
});

test('future-dated positive evidence does not satisfy freshness proof',()=>{
  const result=assessOutcomeContract({
    id:'proof',
    required:[{factKey:'document.saved',maxEvidenceAgeMs:60_000}]
  },[{
    factKey:'document.saved',
    status:'KNOWN',
    confidence:0.99,
    selectedValueDigest:A,
    supportingEvidence:[{
      digest:A,source:'future',observedAt:'2026-10-05T00:01:00.000Z',independenceKey:'future'
    }],
    contradictingEvidence:[],
    staleEvidence:[],
    alternatives:[{valueDigest:A,confidence:0.99}],
    updatedAt:T0
  }],{now:new Date(T0)});
  assert.equal(result.ok,false);
});

function promotionCriteria():PolicyPromotionCriteria{
  return{
    minPairedDecisions:10,
    minCandidateTasks:10,
    minBaselineTasks:10,
    minCalibrationSamples:10,
    minOutcomeCoverage:0.8,
    minProgressCoverage:0.5,
    minCostCoverage:0.5,
    minNetShadowWinRate:0,
    minMeanShadowProgressDelta:-0.01,
    maxMeanShadowCostDelta:0.1,
    maxFalseGoalProgressRate:0.05,
    maxRepeatedEquivalentFailureRate:0.2,
    maxExpectedCalibrationError:0.2,
    maxBrierScore:0.3,
    maxFirstStrategySuccessRegression:0.05,
    maxRecoverySuccessRegression:0.05
  };
}
function metrics(taskCount:number):IntelligenceMetrics{
  return{
    taskCount,
    firstStrategySuccessRate:0.8,
    recoverySuccessRate:0.8,
    falseGoalProgressRate:0,
    repeatedEquivalentFailureRate:0,
    averageStepsPerTask:5
  };
}
function shadow():ShadowComparisonReport{
  return{
    pairedDecisions:20,
    pairedOutcomeDecisions:20,
    outcomeCoverage:1,
    progressCoverage:1,
    costCoverage:1,
    agreementRate:0.5,
    divergenceRate:0.5,
    shadowWinRate:0.2,
    controlWinRate:0.1,
    tiedOutcomeRate:0.7,
    meanShadowProgressDelta:0.1,
    meanShadowCostDelta:-0.1,
    unmatchedShadow:0,
    unmatchedControl:0
  };
}

test('zero-sample calibration cannot pass policy promotion just because error metrics default to zero',()=>{
  const result=assessPolicyPromotion({
    shadow:shadow(),
    candidateMetrics:metrics(20),
    baselineMetrics:metrics(20),
    calibration:{
      samples:0,
      brierScore:0,
      expectedCalibrationError:0,
      meanPrediction:0,
      empiricalSuccess:0,
      buckets:[]
    }
  },promotionCriteria());
  assert.equal(result.eligible,false);
  assert.ok(result.reasons.some(reason=>reason.startsWith('calibration-sample failed')));
});

function step(index:number,effect:string,failed:boolean):TrajectoryStep{
  return{
    index,
    action:{id:'a'+index,family:'pointer',capability:'ui.interact',risk:'write',expectedEffects:[effect]},
    outcome:{ok:!failed,sideEffectState:failed?'none':'known',executionPhase:'effect_observed',evidence:[]},
    delta:{
      changedFactKeys:failed?[]:[effect],
      addedFactKeys:[],removedFactKeys:[],
      expectedEffectsSatisfied:failed?[]:[effect],
      expectedEffectsMissing:failed?[effect]:[],
      unrelatedEffects:[],progressSignals:failed?[]:['advance']
    },
    progress:{
      level:failed?'NONE':'SUBGOAL_PROGRESS',
      confidence:failed?0:0.8,
      creditedSignals:[],rejectedSignals:[],
      goalFactsSatisfied:[],goalFactsMissing:[],
      forbiddenFactsObserved:[],verificationRequired:true
    },
    ...(failed?{failure:{
      primary:{class:'ACTION_NO_EFFECT',probability:1,reasons:['failed'],evidence:[]},
      alternatives:[],entropy:0,evidenceCoverage:1
    }}:{})
  };
}

test('same action family on different expected effects is not counted as repeated equivalent failure',()=>{
  const result=computeIntelligenceMetrics([{
    taskId:'task',
    steps:[step(0,'left.changed',true),step(1,'right.changed',true)],
    finalVerifiedSuccess:false
  }]);
  assert.equal(result.repeatedEquivalentFailureRate,0);
});

test('eventual success after any failure is recovery success, not first-strategy success',()=>{
  const result=computeIntelligenceMetrics([{
    taskId:'task',
    steps:[step(0,'phase.one',false),step(1,'phase.two',false),step(2,'goal.done',false)],
    finalVerifiedSuccess:true
  }]);
  assert.equal(result.firstStrategySuccessRate,0);
  assert.equal(result.recoverySuccessRate,1);
});
