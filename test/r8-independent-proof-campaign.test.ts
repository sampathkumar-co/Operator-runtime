import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR8IndependentProofCampaign,
  createR8IndependentProofCampaign,
  verifyR8IndependentProofCampaign
} from '../src/core/r8-independent-proof-campaign.ts';

const sha=(v:string)=>crypto.createHash('sha256').update(v,'utf8').digest('hex');
const sourceSha='23a1946e7e0b86aa28dc225b0afb57f38808e33f';
const classes=['repo-write','dependency-change','database-migration','browser-workflow','service-config'];

function caseFor(index:number,overrides:Record<string,unknown>={}):any{
  const insufficient=index<10;
  const inference=index<10;
  return {
    caseId:'case-'+index,
    mutationClass:classes[index%classes.length],
    executorId:'executor-'+(index%3),
    verifierId:'verifier-'+(index%2),
    verifierExternalToExecutor:true,
    requiredDimensions:['repository','environment','policy'],
    modeledDimensions:insufficient?['repository','policy']:['repository','environment','policy'],
    absentDimensions:insufficient?['environment']:[],
    fidelityDeclaredBeforeExecution:true,
    insufficientFidelityDenied:insufficient,
    alternativePlansCompared:3,
    selectedPlanDigest:sha('plan-'+index),
    proofBundleDigest:sha('proof-'+index),
    proofVerifiedExternally:true,
    artifactHashesVerifiedExternally:true,
    signatureVerifiedExternally:true,
    tamperAttemptRejected:true,
    inferencePromotionAttempted:inference,
    inferencePromotionRejected:inference,
    mutationExecuted:!insufficient,
    postconditionVerified:!insufficient,
    residualUncertaintyCount:0,
    evidenceDigests:[sha('evidence-'+index)],
    ...overrides
  };
}
function body(overrides:Record<string,unknown>={}):any{
  return {
    schemaVersion:1,
    sourceSha,
    campaignId:'r8-proof-001',
    independentVerifierImplementation:true,
    verifierProcessSeparated:true,
    executorAndVerifierCodepathsSeparated:true,
    cases:Array.from({length:50},(_,i)=>caseFor(i)),
    externalEvidenceDigests:[sha('verifier-build'),sha('proof-report'),sha('tamper-report')],
    ...overrides
  };
}

test('R8 campaign certifies independent proof verification across representative cases',()=>{
  const campaign=createR8IndependentProofCampaign(body());
  const report=certifyR8IndependentProofCampaign(campaign);
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.caseCount,50);
  assert.equal(report.mutationClassCount,5);
  assert.equal(report.independentVerificationRate,1);
  assert.equal(report.explicitFidelityRate,1);
  assert.equal(report.externalProofVerificationRate,1);
  assert.equal(report.tamperRejectionRate,1);
  assert.equal(report.inferencePromotionRejectionRate,1);
  assert.equal(report.insufficientFidelityDenialCount,10);
  assert.equal(report.verifiedMutationRate,1);
});

test('R8 requires independent verifier code and process separation',()=>{
  const report=certifyR8IndependentProofCampaign(createR8IndependentProofCampaign(body({
    independentVerifierImplementation:false,
    verifierProcessSeparated:false
  })));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/independently implemented|outside the executing process/);
});

test('R8 fails when inference promotion is not rejected',()=>{
  const bad=body();
  bad.cases[0].inferencePromotionRejected=false;
  const report=certifyR8IndependentProofCampaign(createR8IndependentProofCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.ok(report.inferencePromotionRejectionRate<1);
});

test('R8 fails when twin fidelity is hidden or insufficient fidelity is not denied',()=>{
  const bad=body();
  bad.cases[0].fidelityDeclaredBeforeExecution=false;
  for(let i=0;i<10;i++)bad.cases[i].insufficientFidelityDenied=false;
  const report=certifyR8IndependentProofCampaign(createR8IndependentProofCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/fidelity/);
});

test('R8 requires proof signature and artifact hashes to verify outside executor',()=>{
  const bad=body();
  bad.cases[1].signatureVerifiedExternally=false;
  bad.cases[2].artifactHashesVerifiedExternally=false;
  const report=certifyR8IndependentProofCampaign(createR8IndependentProofCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.ok(report.externalProofVerificationRate<1);
});

test('R8 rejects executed mutations with unresolved uncertainty or failed postcondition proof',()=>{
  const bad=body();
  bad.cases[20].postconditionVerified=false;
  bad.cases[21].residualUncertaintyCount=1;
  const report=certifyR8IndependentProofCampaign(createR8IndependentProofCampaign(bad));
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.ok(report.verifiedMutationRate<1);
});

test('R8 campaign digest detects tampering',()=>{
  const campaign=createR8IndependentProofCampaign(body());
  assert.equal(verifyR8IndependentProofCampaign(campaign),true);
  const tampered=structuredClone(campaign);
  tampered.body.cases[0]!.proofVerifiedExternally=false;
  assert.equal(verifyR8IndependentProofCampaign(tampered),false);
});
