import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { OriginalRecoveryWebAuthnVerifier } from '../apps/local-agent/src/original-recovery-webauthn.ts';

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
  const verifier=new OriginalRecoveryWebAuthnVerifier({
    rpId,origin,clock,
    credential:{credentialId,publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
      deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true}
  });
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
test('a pinned device-bound passkey can verify one fresh case-bound challenge once',()=>{
  const {verifier,privateKey,credentialId}=fixture();
  const challenge=verifier.challenge(candidate);
  const assertion=signedProof(challenge.challenge,credentialId,privateKey);
  verifier.verifyAndConsume({challengeId:challenge.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,assertion});
  assert.throws(()=>verifier.verifyAndConsume({challengeId:challenge.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion}),/CHALLENGE_INVALID_OR_EXPIRED/);
});
test('a challenge for another case, bad signature and wrong origin never produce verification',()=>{
  const {verifier,privateKey,credentialId}=fixture();
  const challenge=verifier.challenge(candidate);
  const assertion=signedProof(challenge.challenge,credentialId,privateKey);
  assert.throws(()=>verifier.verifyAndConsume({challengeId:challenge.challengeId,actionId:candidate.actionId,
    caseDigest:'5'.repeat(64),assertion}),/CHALLENGE_INVALID_OR_EXPIRED/);
  const c2=verifier.challenge(candidate);
  const altered=signedProof(c2.challenge,credentialId,privateKey,{origin:'https://other.example'});
  assert.throws(()=>verifier.verifyAndConsume({challengeId:c2.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion:altered}),/CLIENT_DATA_MISMATCH/);
  const c3=verifier.challenge(candidate);
  const foreign=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
  assert.throws(()=>verifier.verifyAndConsume({challengeId:c3.challengeId,
    actionId:candidate.actionId,caseDigest:candidate.caseDigest,
    assertion:signedProof(c3.challenge,credentialId,foreign)}),/SIGNATURE_INVALID/);
});
test('missing UP/UV, wrong RP and backup-eligible credentials are rejected',()=>{
  for(const [options,reason] of [
    [{flags:0x01},'USER_VERIFICATION'],
    [{flags:0x04},'USER_VERIFICATION'],
    [{flags:0x0d},'DEVICE_BOUND'],
    [{rpId:'evil.example'},'RP_MISMATCH']
  ] as const){
    const {verifier,privateKey,credentialId}=fixture();
    const c=verifier.challenge(candidate);
    const assertion=signedProof(c.challenge,credentialId,privateKey,options);
    assert.throws(()=>verifier.verifyAndConsume({challengeId:c.challengeId,
      actionId:candidate.actionId,caseDigest:candidate.caseDigest,assertion}),new RegExp(reason));
  }
});
test('expired challenge and different protected device are refused',()=>{
  let now=1000000;
  const {verifier,privateKey,credentialId}=fixture(()=>now);
  assert.throws(()=>verifier.challenge({...candidate,deviceId:'another-device'}),/ORIGINAL_DEVICE_MISMATCH/);
  const c=verifier.challenge(candidate);now+=90001;
  assert.throws(()=>verifier.verifyAndConsume({challengeId:c.challengeId,actionId:candidate.actionId,
    caseDigest:candidate.caseDigest,
    assertion:signedProof(c.challenge,credentialId,privateKey)}),/CHALLENGE_INVALID_OR_EXPIRED/);
});
test('wrong RP origin and unprovisioned credential are refused before any challenge',()=>{
  const {publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credential={credentialId:crypto.randomBytes(32).toString('base64url'),
    publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString(),
    deviceId:candidate.deviceId,deviceFingerprint:candidate.deviceFingerprint,signCount:0,deviceBound:true as const};
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({rpId:'not-localhost',origin,credential}),/RP_ORIGIN_MISMATCH/);
  assert.throws(()=>new OriginalRecoveryWebAuthnVerifier({rpId,origin,credential:{...credential,deviceBound:false as never}}),
    /PROVISIONING_REQUIRED/);
});
