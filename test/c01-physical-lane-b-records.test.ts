import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { laneBPhysicalReceiptRecord, partialLaneBPhysicalReport } from '../scripts/c01-physical-lane-b-records.mjs';
const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const nonce = 'a'.repeat(24);
function accepted(i: number) {
  const expected = {id:'id-' + i + '-' + nonce,
    value:'value-' + i + '-' + nonce, receipt:'receipt-' + i + '-' + nonce};
  return {
    sourceCommit:sha, ordinal:i, runNonce:nonce,
    runnerSha256:digest, environmentSha256:'c'.repeat(64),
    expected, server:{...expected,accepted:true},
    preState:'NOT_COMPLETE', observedPostState:'VERIFIED',
    latencyMs:123.5+i, rejectedSubmissions:0
  };
}
test('C01 actual server ledger verified pairs produce exact source-matched partial Lane B records', () => {
  const records=Array.from({length:5},(_,i)=>laneBPhysicalReceiptRecord(accepted(i)));
  assert.ok(records.every(r=>r.lane==='B'&&r.arm==='mecord_scripted'&&r.model==='scripted'&&r.verifiedSuccess===true));
  assert.ok(records.every(r=>r.costMicros===0&&r.unauthorizedEffects===0));
  const report=partialLaneBPhysicalReport({sourceCommit:sha,records});
  assert.equal(report.lanes.A.status,'NOT_RUN');
  assert.equal(report.lanes.C.status,'NOT_RUN');
  assert.equal(report.lanes.B.status,'PARTIAL');
  assert.equal(report.lanes.B.evidence.runs,5);
  assert.equal(report.lanes.B.evidence.verifiedSuccesses,5);
  assert.equal(report.lanes.B.evidence.falseCompletions,0);
  assert.equal(report.releaseAcceptance,'NOT_ACCEPTED');
});
test('C01 inaccurate before-state or server receipt cannot be laundered as Lane B success',()=>{
  const a=accepted(0);
  for(const tamper of [
    {preState:'VERIFIED'},
    {observedPostState:'NOT_COMPLETE'},
    {server:{...a.server,receipt:'forged'}},
    {server:{...a.server,value:'forged'}},
    {server:{...a.server,accepted:false}},
    {rejectedSubmissions:1},
    {runNonce:'invalid'},
    {sourceCommit:'b'.repeat(39)},
    {ordinal:5}
  ]) assert.throws(()=>laneBPhysicalReceiptRecord({...a,...tamper}),/C01_LANE_B_RECEIPT_INVALID/);
});
test('C01 source-only and five controlled tasks never imply 50 real users, model or release acceptance',()=>{
  const records=Array.from({length:5},(_,i)=>laneBPhysicalReceiptRecord(accepted(i)));
  assert.throws(()=>partialLaneBPhysicalReport({sourceCommit:sha,records:records.slice(1)}),
    /exact five/);
  assert.throws(()=>partialLaneBPhysicalReport({sourceCommit:'c'.repeat(40),records}),
    /exact five/);
});
