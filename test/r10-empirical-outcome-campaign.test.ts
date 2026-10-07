import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR10EmpiricalOutcomeCampaign,
  createR10EmpiricalOutcomeCampaign,
  verifyR10EmpiricalOutcomeCampaign,
  type R10ExecutionMode
} from '../src/core/r10-empirical-outcome-campaign.ts';

const sha=(v:string)=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const sourceSha='84145cdcddf9736707ffe9970add63bc7fe879a4';

function observation(mode:R10ExecutionMode,index:number):any{
  const baseline=mode==='direct-tool-access';
  const verifiedSuccess=baseline?index<21:index<26;
  const claimedComplete=verifiedSuccess||(baseline?(index>=21&&index<27):(index>=26&&index<28));
  const human=baseline?index<18:index<9;
  const interrupted=index<10;
  const recoverySucceeded=interrupted&&(baseline?index<8:true);
  const rollbackRequired=index<10;
  const rollbackSucceeded=rollbackRequired&&(baseline?index<8:true);
  const portableProof=baseline?index<20:true;
  return {
    mode,
    executorId:(baseline?'baseline-executor-':'r10-executor-')+index,
    verifierId:'verifier-'+(index%3),
    independentVerifier:true,
    claimedComplete,
    verifiedSuccess,
    humanInterventionCount:human?1:0,
    humanInterventionMinutes:human?(baseline?10:4):0,
    interrupted,
    recoverySucceeded,
    ...(recoverySucceeded?{recoveryReceiptDigest:sha(mode+':recovery:'+index)}:{}),
    authorityViolations:0,
    portableProof,
    ...(portableProof?{portableProofDigest:sha(mode+':proof:'+index)}:{}),
    predictedSuccessProbability:baseline?(verifiedSuccess?.8:.6):(verifiedSuccess?.95:.1),
    rollbackRequired,
    rollbackSucceeded,
    ...(rollbackSucceeded?{rollbackReceiptDigest:sha(mode+':rollback:'+index)}:{}),
    learningPolicyViolations:0,
    resultDigest:sha(mode+':result:'+index),
    evidenceDigests:[sha(mode+':evidence:'+index)]
  };
}

function pair(index:number):any{
  return {
    pairId:'pair-'+index,
    category:'category-'+(index%6),
    objectiveDigest:sha('objective:'+index),
    startingStateDigest:sha('start:'+index),
    environmentDigest:sha('environment:'+index),
    r10SourceSha:sourceSha,
    rubricDigest:sha('rubric:'+index),
    rubricFrozenBeforeExecution:true,
    startingStateReproducible:true,
    verifierBlindedToMode:true,
    executionOrder:index<15?'baseline-first':'r10-first',
    baseline:observation('direct-tool-access',index),
    current:observation('mecord-r10',index),
    evidenceDigests:[sha('pair-evidence:'+index)]
  };
}

function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    sourceSha,
    campaignId:'r10-empirical-001',
    priorReleaseCertifications:Array.from({length:9},(_,i)=>({
      release:'R'+(i+1),
      status:'CERTIFIED',
      reportDigest:sha('release-report:'+(i+1)),
      sourceSha
    })),
    pairs:Array.from({length:30},(_,i)=>pair(i)),
    externalEvidenceDigests:[sha('cohort-manifest'),sha('verifier-manifest'),sha('analysis-report')],
    ...overrides
  };
}

test('R10 certifies a counterbalanced paired cohort that materially beats direct tool access',()=>{
  const campaign=createR10EmpiricalOutcomeCampaign(body());
  const report=certifyR10EmpiricalOutcomeCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.pairCount,30);
  assert.equal(report.categoryCount,6);
  assert.equal(report.verifierCount,3);
  assert.equal(report.baselineFirstCount,15);
  assert.equal(report.r10FirstCount,15);
  assert.equal(report.interruptionCaseCount,10);
  assert.equal(report.rollbackCaseCount,10);
  assert.equal(report.baseline.verifiedTaskSuccessRate,.7);
  assert.equal(report.current.verifiedTaskSuccessRate,.866667);
  assert.equal(report.baseline.falseCompletionRate,.2);
  assert.equal(report.current.falseCompletionRate,.066667);
  assert.equal(report.baseline.humanInterventionRate,.6);
  assert.equal(report.current.humanInterventionRate,.3);
  assert.equal(report.current.interruptionRecoveryRate,1);
  assert.equal(report.current.portableProofRate,1);
  assert.equal(report.current.rollbackSuccessRate,1);
  assert.equal(report.current.authorityViolations,0);
  assert.equal(report.current.learningPolicyViolations,0);
  assert.ok(report.current.uncertaintyCalibrationError<=.1);
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
});

test('R10 refuses a weaker custom engineering standard',()=>{
  assert.throws(()=>createR10EmpiricalOutcomeCampaign(body({
    standard:{minSuccessAbsoluteGain:.01}
  })),/weaker than the R10 minimum/);
});

test('R10 requires all R1-R9 certified evidence digests before final certification',()=>{
  const bad=body();
  bad.priorReleaseCertifications=bad.priorReleaseCertifications.slice(0,8);
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/R9/);
});

test('R10 binds every R10 arm to the exact campaign source SHA',()=>{
  const bad=body();
  bad.pairs[0].r10SourceSha='a'.repeat(40);
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/certification source SHA/);
});

test('R10 requires blinded independent verification and a frozen reproducible rubric',()=>{
  const bad=body();
  bad.pairs[0].verifierBlindedToMode=false;
  bad.pairs[1].rubricFrozenBeforeExecution=false;
  bad.pairs[2].startingStateReproducible=false;
  bad.pairs[3].current.independentVerifier=false;
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/blinded|rubric|starting state|independent/);
});

test('R10 requires counterbalanced execution order, enough recovery/rollback cases, and multiple verifiers',()=>{
  const bad=body();
  for(const p of bad.pairs){
    p.executionOrder='baseline-first';
    p.current.verifierId='verifier-only';
    p.baseline.verifierId='verifier-only';
    p.current.interrupted=false;p.current.recoverySucceeded=false;delete p.current.recoveryReceiptDigest;
    p.current.rollbackRequired=false;p.current.rollbackSucceeded=false;delete p.current.rollbackReceiptDigest;
  }
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/counterbalanced|interruption|rollback|verifier/);
});

test('R10 derives metrics from raw observations and fails when outcome improvement disappears',()=>{
  const bad=body();
  for(let i=0;i<bad.pairs.length;i++){
    bad.pairs[i].current.verifiedSuccess=bad.pairs[i].baseline.verifiedSuccess;
    bad.pairs[i].current.claimedComplete=bad.pairs[i].baseline.claimedComplete;
    bad.pairs[i].current.humanInterventionCount=bad.pairs[i].baseline.humanInterventionCount;
    bad.pairs[i].current.humanInterventionMinutes=bad.pairs[i].baseline.humanInterventionMinutes;
    bad.pairs[i].current.predictedSuccessProbability=bad.pairs[i].current.verifiedSuccess?.95:.1;
  }
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.current.verifiedTaskSuccessRate,report.baseline.verifiedTaskSuccessRate);
  assert.match(report.reasons.join(' '),/false completion|human intervention|success improvement/);
});

test('R10 computes uncertainty calibration over probability cohorts',()=>{
  const calibrated=body();
  for(let i=0;i<calibrated.pairs.length;i++){
    calibrated.pairs[i].current.verifiedSuccess=i<24;
    calibrated.pairs[i].current.claimedComplete=true;
    calibrated.pairs[i].current.predictedSuccessProbability=.8;
  }
  const report=certifyR10EmpiricalOutcomeCampaign(createR10EmpiricalOutcomeCampaign(calibrated));
  assert.equal(report.current.uncertaintyCalibrationError,0);
});

test('R10 rejects intervention minutes without an intervention event',()=>{
  const inconsistent=body();
  inconsistent.pairs[0].current.humanInterventionCount=0;
  inconsistent.pairs[0].current.humanInterventionMinutes=5;
  assert.throws(
    ()=>createR10EmpiricalOutcomeCampaign(inconsistent),
    /minutes require at least one intervention/
  );
});

test('R10 campaign digest detects paired evidence tampering',()=>{
  const campaign=createR10EmpiricalOutcomeCampaign(body());
  assert.equal(verifyR10EmpiricalOutcomeCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.pairs[0]!.current.authorityViolations=1;
  assert.equal(verifyR10EmpiricalOutcomeCampaign(tampered),false);
});
