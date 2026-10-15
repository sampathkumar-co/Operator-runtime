import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { OriginalRecoveryWebAuthnVerifier } from '../apps/local-agent/src/original-recovery-webauthn.ts';
import { independentlySignedTestOwnerEnrollment } from './recovery-enrollment-fixture.ts';

const rpId='localhost',origin='http://localhost:8300';
const candidate={
  actionId:'mcp-test-1234567890123456',actionDigest:'1'.repeat(64),
  receiptAuthorityHash:'2'.repeat(64),receiptOwnerId:'original-process',
  journalGeneration:1,transitionsDigest:'3'.repeat(64),recoveryEpoch:1,
  deviceId:'trusted-original-device',deviceFingerprint:'Z'.repeat(43),caseDigest:'4'.repeat(64)
};
function fixture(clock=()=>Date.now()){
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=crypto.randomBytes(32).toString('base64url');
  const credential={credentialId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
    deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true as const};
  const proof=independentlySignedTestOwnerEnrollment(credential,{rpId,origin,now:clock()});
  const consumed=new Set<string>();
  let lastSignCount=0;
  const counterAuthority={async claimVerifiedAssertion(input:{challengeId:string;signCount:number}){
    if(consumed.has(input.challengeId)|| (lastSignCount>0 && input.signCount<=lastSignCount))
      throw new Error('WEBAUTHN_DURABLE_COUNTER_REPLAY');
    consumed.add(input.challengeId);
    if(input.signCount)lastSignCount=input.signCount;
  }};
  const verifier=new OriginalRecoveryWebAuthnVerifier({rpId,origin,clock,...proof,counterAuthority});
  return {verifier,credentialId,privateKey};
}
function signedProof(challenge:string,credentialId:string,privateKey:crypto.KeyObject,opts:{flags?:number;origin?:string;rpId?:string;signCount?:number}={}){
  const clientData=Buffer.from(JSON.stringify({
    type:'webauthn.get',challenge,origin:opts.origin??origin,crossOrigin:false
  }));
  const auth=Buffer.alloc(37);
  crypto.createHash('sha256').update(opts.rpId??rpId).digest().copy(auth,0);
  auth[32]=opts.flags??0x05;
  auth.writeUInt32BE(opts.signCount??1,33);
  const payload=Buffer.concat([auth,crypto.createHash('sha256').update(clientData).digest()]);
  const signature=crypto.sign('sha256',payload,privateKey);
  return {id:credentialId,response:{
    clientDataJSON:clientData.toString('base64url'),
    authenticatorData:auth.toString('base64url'),
    signature:signature.toString('base64url')
  }};
}
test('a pinned device-bound passkey can verify one fresh case-bound challenge once',async()=>{
  const {verifier,privateKey,credentialId}=fixture();
  const challenge=verifier.challenge(candidate);
  const assertion=signedProof(challenge.challenge,credentialId,privateKey);
  await verifier.verifyAndConsume({challengeId:challenge.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,assertion});
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:challenge.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion}),/CHALLENGE_INVALID_OR_EXPIRED/);
});
test('a challenge for another case, bad signature and wrong origin never produce verification',async()=>{
  const {verifier,privateKey,credentialId}=fixture();
  const challenge=verifier.challenge(candidate);
  const assertion=signedProof(challenge.challenge,credentialId,privateKey);
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:challenge.challengeId,actionId:candidate.actionId,
    caseDigest:'5'.repeat(64),assertion}),/CHALLENGE_INVALID_OR_EXPIRED/);
  const c2=verifier.challenge(candidate);
  const altered=signedProof(c2.challenge,credentialId,privateKey,{origin:'https://other.example'});
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c2.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion:altered}),/CLIENT_DATA_MISMATCH/);
  const c3=verifier.challenge(candidate);
  const foreign=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c3.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,
    assertion:signedProof(c3.challenge,credentialId,foreign)}),/SIGNATURE_INVALID/);
});
test('missing UP/UV, wrong RP and backup-eligible credentials are rejected',async()=>{
  for(const [options,reason] of [
    [{flags:0x01},'USER_VERIFICATION'],
    [{flags:0x04},'USER_VERIFICATION'],
    [{flags:0x0d},'DEVICE_BOUND'],
    [{rpId:'evil.example'},'RP_MISMATCH']
  ] as const){
    const {verifier,privateKey,credentialId}=fixture();
    const c=verifier.challenge(candidate);
    const assertion=signedProof(c.challenge,credentialId,privateKey,options);
    await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c.challengeId,
      actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion}),new RegExp(reason));
  }
});
test('expired challenge and different protected device are refused',async()=>{
  let now=1000000;
  const {verifier,privateKey,credentialId}=fixture(()=>now);
  assert.throws(()=>verifier.challenge({...candidate,deviceId:'another-device'}),/ORIGINAL_DEVICE_MISMATCH/);
  const c=verifier.challenge(candidate);now+=90001;
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,
    assertion:signedProof(c.challenge,credentialId,privateKey)}),/CHALLENGE_INVALID_OR_EXPIRED/);
});
test('wrong RP origin and unprovisioned credential are refused before any challenge',async()=>{
  const {publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credential={credentialId:crypto.randomBytes(32).toString('base64url'),
    publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
    deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true as const};
  const signed=independentlySignedTestOwnerEnrollment(credential,{rpId,origin,now:Date.now()});
  const counterAuthority={async claimVerifiedAssertion(){}};
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({
    rpId:'not-localhost',origin,...signed,counterAuthority
  }),/RP_ORIGIN_MISMATCH/);
  const tampered=structuredClone(signed.enrollment);
  tampered.payload.credential.deviceBound=false as never;
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,enrollment:tampered,pinnedIssuerPublicKeyPem:signed.pinnedIssuerPublicKeyPem,counterAuthority
  }),/ENROLLMENT_PROVENANCE_INVALID/);
  const swapped=structuredClone(signed.enrollment);
  swapped.payload.credential.deviceId='attacker-device';
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,enrollment:swapped,pinnedIssuerPublicKeyPem:signed.pinnedIssuerPublicKeyPem,counterAuthority
  }),/ENROLLMENT_SIGNATURE_UNTRUSTED/);
  const wrongAnchor=crypto.generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,enrollment:signed.enrollment,pinnedIssuerPublicKeyPem:wrongAnchor,counterAuthority
  }),/ENROLLMENT_SIGNATURE_UNTRUSTED/);
});

test('remote signer refuses to verify when durable counter authority is offline',async()=>{
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=crypto.randomBytes(32).toString('base64url');
  const credential={credentialId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
    deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true as const};
  const signed=independentlySignedTestOwnerEnrollment(credential,{rpId,origin,now:Date.now()});
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,...signed,counterAuthority:undefined as never
  }),/WEBAUTHN_DURABLE_REPLAY_AUTHORITY_REQUIRED/);
  const verifier=new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,...signed,
    counterAuthority:{async claimVerifiedAssertion(){throw new Error('INDEPENDENT_LEDGER_UNAVAILABLE')}}
  });
  const c=verifier.challenge(candidate);
  const assertion=signedProof(c.challenge,credentialId,privateKey);
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,assertion}),/INDEPENDENT_LEDGER_UNAVAILABLE/);
  await assert.rejects(()=>verifier.verifyAndConsume({challengeId:c.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,assertion}),/CHALLENGE_INVALID_OR_EXPIRED/);
});

test('expired signed enrollment cannot issue or complete a verification challenge',async()=>{
  let now=1_000_000;
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=crypto.randomBytes(32).toString('base64url');
  const credential={credentialId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
    deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true as const};
  const signed=independentlySignedTestOwnerEnrollment(credential,{rpId,origin,now});
  const verifier=new OriginalRecoveryWebAuthnVerifier({rpId,origin,...signed,clock:()=>now,
    counterAuthority:{async claimVerifiedAssertion(){throw new Error('should not happen')}}});
  const c=verifier.challenge(candidate);
  now+=24*3600*1000+1;
  await assert.rejects(()=>verifier.verifyAndConsume({
    challengeId:c.challengeId,actionId:candidate.actionId,caseDigest:candidate.caseDigest,
    assertion:signedProof(c.challenge,credentialId,privateKey)
  }),/CHALLENGE_INVALID_OR_EXPIRED/);
  assert.throws(()=>verifier.challenge(candidate),/WEBAUTHN_ENROLLMENT_EXPIRED/);
});
