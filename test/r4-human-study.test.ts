import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyR4HumanStudy,
  createR4HumanStudySession,
  verifyR4HumanStudySession
} from '../src/core/r4-human-study.ts';

const sourceSha='c0377279b69dcd5b6817480776c1876f1889fb3a';
const environmentDigest=crypto.createHash('sha256').update('r4-study-env','utf8').digest('hex');

function session(id:string,minutes:number,overrides:Record<string,unknown>={}){
  const startedAt='2026-10-07T10:00:00.000Z';
  const verifiedTaskAt=new Date(Date.parse(startedAt)+minutes*60_000).toISOString();
  return createR4HumanStudySession({
    schemaVersion:1,
    participantId:id,
    sourceSha,
    environmentDigest,
    externalParticipant:true,
    preparedParticipant:true,
    consentRecorded:true,
    startedAt,
    verifiedTaskAt,
    primaryWorkflowCompleted:true,
    developerAssistanceEvents:[],
    onboarding:{install:true,doctor:true,authenticate:true,pair:true,roots:true,readProbe:true,approvalProbe:true,guidedVerifiedTask:true},
    approvalComprehension:{completedWithoutDocs:true,requestedEffect:true,scope:true,risk:true,reversibility:true,alternatives:true,exactResource:true,expiry:true,reason:true},
    recoveryComprehension:{retryable:true,reconcilable:true,reversible:true,blocked:true,terminal:true,uncertain:true},
    proofInspection:{opened:true,identifiedAuthority:true,identifiedActionEffect:true,identifiedVerification:true},
    causalTimelineUnderstood:true,
    ...overrides
  } as any);
}

test('R4 human study certifies an assistance-free external prepared-user cohort',()=>{
  const sessions=[
    session('p-1',8),
    session('p-2',10),
    session('p-3',12),
    session('p-4',14),
    session('p-5',18)
  ];
  const report=certifyR4HumanStudy({sourceSha,sessions});
  assert.equal(report.status,'CERTIFIED');
  assert.equal(report.eligibleParticipantCount,5);
  assert.equal(report.completionRate,1);
  assert.equal(report.assistanceFreeCompletionRate,1);
  assert.equal(report.approvalComprehensionRate,1);
  assert.equal(report.recoveryComprehensionRate,1);
  assert.equal(report.proofInspectionRate,1);
  assert.equal(report.medianMinutesToVerifiedTask,12);
  assert.match(report.reportDigest,/^[0-9a-f]{64}$/);
});

test('R4 human study does not count internal or unprepared participants toward external gate',()=>{
  const sessions=[
    session('p-1',8),
    session('p-2',10),
    session('internal',7,{externalParticipant:false}),
    session('unprepared',9,{preparedParticipant:false}),
    session('no-consent',9,{consentRecorded:false})
  ];
  const report=certifyR4HumanStudy({sourceSha,sessions});
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.equal(report.eligibleParticipantCount,2);
  assert.match(report.reasons.join(' '),/participant count/);
});

test('R4 human study fails when users need developer assistance or do not understand approvals',()=>{
  const sessions=[
    session('p-1',8),
    session('p-2',10),
    session('p-3',12,{developerAssistanceEvents:['developer explained recovery']}),
    session('p-4',14,{approvalComprehension:{completedWithoutDocs:false,requestedEffect:true,scope:true,risk:true,reversibility:true,alternatives:true,exactResource:true,expiry:true,reason:true}}),
    session('p-5',18,{approvalComprehension:{completedWithoutDocs:true,requestedEffect:true,scope:true,risk:false,reversibility:true,alternatives:true,exactResource:true,expiry:true,reason:true}})
  ];
  const report=certifyR4HumanStudy({sourceSha,sessions});
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.ok(report.assistanceFreeCompletionRate<1);
  assert.ok(report.approvalComprehensionRate<0.9);
  assert.match(report.reasons.join(' '),/assistance-free|approval comprehension/);
});

test('R4 human study fails slow first-task cohort against declared standard',()=>{
  const sessions=[session('p-1',25),session('p-2',30),session('p-3',35),session('p-4',40),session('p-5',50)];
  const report=certifyR4HumanStudy({sourceSha,sessions});
  assert.equal(report.status,'NOT_CERTIFIED');
  assert.match(report.reasons.join(' '),/median|p90/);
});

test('R4 session digest detects tampering',()=>{
  const original=session('p-1',8);
  assert.equal(verifyR4HumanStudySession(original),true);
  const tampered=structuredClone(original);
  tampered.body.developerAssistanceEvents.push('hidden help');
  assert.equal(verifyR4HumanStudySession(tampered),false);
});

test('R4 study requires all session evidence to bind to the exact certification source SHA',()=>{
  const wrong=createR4HumanStudySession({...session('p-1',8).body,sourceSha:'a'.repeat(40)});
  assert.throws(()=>certifyR4HumanStudy({sourceSha,sessions:[wrong]}),/source SHA/);
});
