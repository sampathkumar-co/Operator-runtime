import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { independentCampaignEvidencePayload, type IndependentCampaignEvidence } from '../src/core/independent-campaign-evidence.ts';
import { runRealisticJourneyCampaign, type RealisticJourneyRunnerInput } from '../src/core/c01-realistic-journey-runner.ts';

const sha = (value:string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const sourceCommit = 'a'.repeat(40);

function fixtures() {
  const artifacts = new Map<string,string>();
  const store = (value:string) => { artifacts.set(sha(value), value); return sha(value); };
  const domains = Array.from({length:10},(_,i)=>'domain-'+i);
  const scenarios = Array.from({length:50},(_,i)=>({
    id:'sealed-'+String(i+1).padStart(3,'0'), domain:domains[Math.floor(i/5)]!,
    objectiveDigest:store('objective '+i), fixtureDigest:store('fixture '+i), oracleDigest:store('oracle '+i)
  }));
  const suiteBytes=JSON.stringify({scenarioIds:scenarios.map(item=>item.id)});
  const suiteDigest=store(suiteBytes);
  return { artifacts, objectives:Array.from({length:50},(_,i)=>'objective '+i),
    holdout:{schemaVersion:1 as const,classification:'SEALED_EXTERNAL_HOLDOUT' as const,suiteDigest,scenarios} };
}

function input(overrides:Partial<RealisticJourneyRunnerInput>={}) {
  const f=fixtures();
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  let oracleExposed=false;
  const base:RealisticJourneyRunnerInput={
    sourceCommit,runnerDigest:sha('runner'),environmentDigest:sha('environment'),
    executorId:'fixture-executor',deadlineMs:1000,holdout:f.holdout,
    trustedVerifierPublicKeys:{'independent-verifier':publicKey.export({type:'spki',format:'pem'}).toString()},
    async openScenario({scenarioId,expectedObjectiveDigest,expectedFixtureDigest}) {
      const index=Number(scenarioId.slice(-3))-1;
      return {objective:f.objectives[index]!,objectiveDigest:expectedObjectiveDigest,
        fixtureHandle:'fixture-'+index,fixtureEvidenceDigest:expectedFixtureDigest};
    },
    async executeScenario(request) {
      oracleExposed=oracleExposed||Object.hasOwn(request,'expectedOracleDigest')||Object.hasOwn(request,'oracleDigest');
      const evidence='result '+request.scenarioId;f.artifacts.set(sha(evidence),evidence);
      return {executorId:'fixture-executor',claimedSuccess:true,resultEvidenceDigest:sha(evidence)};
    },
    async scoreScenario({scenarioId,expectedOracleDigest}) {
      assert.match(expectedOracleDigest,/^[0-9a-f]{64}$/);
      const evidence='score '+scenarioId;f.artifacts.set(sha(evidence),evidence);
      return {verifierId:'independent-verifier',verifiedSuccess:true,failureStage:'none',
        unauthorizedEffects:0,scoreEvidenceDigest:sha(evidence)};
    },
    async authenticateEvidence({campaignDigest,requiredEvidenceDigests}) {
      const artifacts=requiredEvidenceDigests.map(digest=>({digest,
        contentBase64:Buffer.from(f.artifacts.get(digest)!,'utf8').toString('base64')}));
      const signatureBase64=crypto.sign(null,
        independentCampaignEvidencePayload(campaignDigest,'independent-verifier',requiredEvidenceDigests),
        privateKey).toString('base64');
      return {attestation:{schemaVersion:1,campaignDigest,verifierId:'independent-verifier',
          artifactDigests:[...requiredEvidenceDigests],signatureBase64},artifacts} satisfies IndependentCampaignEvidence;
    },
    ...overrides
  };
  return {base,oracleWasExposed:()=>oracleExposed};
}

test('no sealed external holdout reports NOT_RUN without inventing outcomes',async()=>{
  const report=await runRealisticJourneyCampaign();
  assert.equal(report.status,'NOT_RUN');
  assert.equal(report.attempted,0);
  assert.equal(report.campaignDigest,null);
  assert.equal(report.releaseAcceptance,'NOT_ACCEPTED');
});

test('50 disposable journeys pass only with independently authenticated scorer evidence',async()=>{
  const fixture=input();
  const report=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(report.status,'PASS');
  assert.equal(report.completed,50);
  assert.equal(report.verifiedSuccesses,50);
  assert.equal(report.authenticatedEvidence,true);
  assert.match(report.campaignDigest!,/^[0-9a-f]{64}$/);
  assert.equal(fixture.oracleWasExposed(),false);
  assert.equal(report.releaseAcceptance,'NOT_ACCEPTED');
});

test('unsigned or forged scorer evidence is deterministic FAIL, never PASS',async()=>{
  const unsigned=input({authenticateEvidence:async()=>undefined});
  const unsignedReport=await runRealisticJourneyCampaign(unsigned.base);
  assert.equal(unsignedReport.status,'FAIL');
  assert.equal(unsignedReport.authenticatedEvidence,false);
  assert.match(unsignedReport.reasons.join(' '),/attestation is missing/);
  const forged=input({authenticateEvidence:async({campaignDigest,requiredEvidenceDigests})=>({
    trustedVerifierPublicKeys:{},attestation:{schemaVersion:1,campaignDigest,
      verifierId:'independent-verifier',artifactDigests:[...requiredEvidenceDigests],
      signatureBase64:Buffer.alloc(64).toString('base64')},artifacts:[]
  })});
  const forgedReport=await runRealisticJourneyCampaign(forged.base);
  assert.equal(forgedReport.status,'FAIL');
  assert.match(forgedReport.reasons.join(' '),/self-select the verifier trust anchor/);
  const unpinned=input({trustedVerifierPublicKeys:{}});
  const unpinnedReport=await runRealisticJourneyCampaign(unpinned.base);
  assert.equal(unpinnedReport.status,'FAIL');
  assert.equal(unpinnedReport.authenticatedEvidence,false);
  assert.match(unpinnedReport.reasons.join(' '),/trust store/);
});

test('an authentic failed outcome remains FAIL and records false completion',async()=>{
  const fixture=input();
  const original=fixture.base.scoreScenario;
  fixture.base.scoreScenario=async request=>request.scenarioId==='sealed-001'
    ? {...await original(request),verifiedSuccess:false,failureStage:'verifier'}
    : original(request);
  const report=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(report.status,'FAIL');
  assert.equal(report.verifiedSuccesses,49);
  assert.equal(report.falseCompletions,1);
  assert.equal(report.authenticatedEvidence,true);
});

test('sealed suite rejects duplicate, unbalanced or answer-bearing manifest fields',async()=>{
  for(const mutate of [
    (holdout:any)=>{holdout.scenarios[1].id=holdout.scenarios[0].id;},
    (holdout:any)=>{holdout.scenarios[0].domain=holdout.scenarios[5].domain;},
    (holdout:any)=>{holdout.scenarios[0].oracleAnswer='hidden answer';}
  ]){
    const fixture=input();const holdout=structuredClone(fixture.base.holdout);mutate(holdout);
    await assert.rejects(()=>runRealisticJourneyCampaign({...fixture.base,holdout}),/C01_REALISTIC_JOURNEY_INVALID/);
  }
});

test('timeout stops the campaign without retrying or opening later fixtures',async()=>{
  let opens=0,executions=0;
  const fixture=input();
  const open=fixture.base.openScenario;
  fixture.base.openScenario=async request=>{opens++;return open(request);};
  fixture.base.executeScenario=async()=>{executions++;return new Promise(()=>{});};
  fixture.base.deadlineMs=100;
  const report=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(report.status,'FAIL');
  assert.equal(report.attempted,1);
  assert.equal(report.completed,0);
  assert.equal(opens,1);
  assert.equal(executions,1);
  assert.match(report.reasons.join(' '),/without retry: TIMEOUT/);
});


test('hung evidence-authentication callback fails the 50-journey report within the deadline',async()=>{
  const fixture=input({authenticateEvidence:async()=>new Promise(()=>{})});
  fixture.base.deadlineMs=100;
  const result=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(result.status,'FAIL');
  assert.equal(result.completed,50);
  assert.equal(result.authenticatedEvidence,false);
  assert.equal(result.releaseAcceptance,'NOT_ACCEPTED');
  assert.match(result.reasons.join(' '),/Independent evidence authentication failed: TIMEOUT/);
});

test('external AbortSignal immediately rejects a stalled fixture callback',async()=>{
  const controller=new AbortController();
  const fixture=input({signal:controller.signal,deadlineMs:5000});
  fixture.base.openScenario=async()=>{
    controller.abort();
    return new Promise(()=>{});
  };
  const result=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(result.status,'FAIL');
  assert.equal(result.attempted,1);
  assert.equal(result.completed,0);
  assert.match(result.reasons.join(' '),/without retry: CANCELLED/);
});

test('external AbortSignal cancels an unresponsive signed-evidence supplier',async()=>{
  const controller=new AbortController();
  const fixture=input({signal:controller.signal,deadlineMs:5000,
    authenticateEvidence:async()=>{
      controller.abort();
      return new Promise(()=>{});
    }});
  const result=await runRealisticJourneyCampaign(fixture.base);
  assert.equal(result.status,'FAIL');
  assert.equal(result.completed,50);
  assert.equal(result.authenticatedEvidence,false);
  assert.match(result.reasons.join(' '),/authentication failed: CANCELLED/);
});


test('fixture callback errors redact secrets instead of leaking into reports', async () => {
  const secret = 'Bearer PRIVATE_FIXTURE_TOKEN_12345';
  const fixture = input({ openScenario: async () => { throw new Error('request failed: ' + secret); } });
  const report = await runRealisticJourneyCampaign(fixture.base);
  assert.equal(report.status, 'FAIL');
  assert.match(report.reasons.join(' '), /UNTRUSTED_CALLBACK_ERROR/);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('evidence authentication errors redact secrets instead of leaking into reports', async () => {
  const secret = 'password=PRIVATE_AUTHENTICATOR_SECRET';
  const fixture = input({ authenticateEvidence: async () => { throw new Error(secret); } });
  const report = await runRealisticJourneyCampaign(fixture.base);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.authenticatedEvidence, false);
  assert.match(report.reasons.join(' '), /Independent evidence authentication failed: UNTRUSTED_CALLBACK_ERROR/);
  assert.ok(!JSON.stringify(report).includes(secret));
});
