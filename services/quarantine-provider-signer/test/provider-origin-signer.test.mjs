import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {authenticateToken,stableMissionId,quarantineIntentId,
  signFromVerifiedObservation,createSigner} from '../provider-origin-signer.mjs';

const now=new Date('2026-10-12T06:00:00.000Z');
const programId=crypto.randomUUID(),returnedMissionId=crypto.randomUUID(),targetKey='service:secure';
const query={programId,targetKey,returnedMissionId};
const origin=crypto.generateKeyPairSync('ed25519');
const signer=crypto.generateKeyPairSync('ed25519');
const foreign=crypto.generateKeyPairSync('ed25519');
const publicPem=key=>key.export({format:'pem',type:'spki'}).toString();
const privatePem=key=>key.export({format:'pem',type:'pkcs8'}).toString();
const issuer='origin:separate-provider';
const token='signer-api:'+crypto.randomBytes(32).toString('hex');
const challenge='a'.repeat(64);
const record={schemaVersion:1,issuer,challenge,intentId:quarantineIntentId(programId,returnedMissionId),
  programId,targetKey,expectedMissionId:stableMissionId(programId,targetKey),
  returnedMissionId,classification:'verified-unrelated',
  evidenceDigest:crypto.randomBytes(32).toString('hex'),providerDeviceId:crypto.randomUUID(),
  providerProcessId:'provider:primary',providerSessionId:crypto.randomUUID(),authorityGeneration:7,
  observedAt:new Date(now.getTime()-1000).toISOString(),
  validUntil:new Date(now.getTime()+59000).toISOString()};
const source=(receipt=record,key=origin.privateKey)=>({
  receipt,signature:crypto.sign(null,Buffer.from(JSON.stringify(receipt),'utf8'),key).toString('base64url')});
const exercise=(originResponse=source(),q=query,options={})=>signFromVerifiedObservation({
  query:q,challenge,originResponse,originPublicKey:publicPem(origin.publicKey),
  signerPrivateKey:privatePem(signer.privateKey),issuer,now,...options});
test('separately signed authentic provider origin becomes a downstream-compatible Ed25519 claim',()=>{
  const {claim,signature}=exercise();
  assert.deepEqual(Object.keys(claim),['schemaVersion','intentId','programId','targetKey',
    'expectedMissionId','returnedMissionId','classification','evidenceDigest','providerDeviceId',
    'providerProcessId','providerSessionId','authorityGeneration','issuedAt','expiresAt']);
  assert.equal(claim.intentId,quarantineIntentId(programId,returnedMissionId));
  assert.equal(claim.expectedMissionId,stableMissionId(programId,targetKey));
  assert.equal(claim.issuedAt,now.toISOString());
  assert.equal(claim.expiresAt,new Date(now.getTime()+59000).toISOString());
  assert.ok(crypto.verify(null,Buffer.from(JSON.stringify(claim),'utf8'),signer.publicKey,
    Buffer.from(signature,'base64url')));
});
test('requester cannot supply origin, signature, arbitrary classification or operator approval',async()=>{
  let lookups=0;
  const sign=createSigner({requestToken:token,originPublicKey:publicPem(origin.publicKey),
    signerPrivateKey:privatePem(signer.privateKey),issuer,clock:()=>now,
    lookup:async request=>{lookups++;assert.deepEqual(({challenge,...identity})=>identity)(request),query);
      assert.match(request.challenge,/^[0-9a-f]{64}$/);
      return source({...record,challenge:request.challenge});}});
  await assert.rejects(sign(token,{...query,classification:'verified-owned'}),/REQUEST_INVALID/);
  await assert.rejects(sign(token,{...query,signature:'spoof'}),/REQUEST_INVALID/);
  await assert.rejects(sign('unauthorized',query),/REQUEST_UNAUTHORIZED/);
  assert.equal(lookups,0);
  assert.equal((await sign(token,query)).claim.classification,'verified-unrelated');
  assert.equal(lookups,1);
});
test('rejects attacker signatures, signed response substitution and unsigned observations',()=>{
  assert.throws(()=>exercise(source(record,foreign.privateKey)),/ORIGIN_SIGNATURE_INVALID/);
  assert.throws(()=>exercise({...source(),signature:'not-signed'}),/ORIGIN_SIGNATURE_INVALID/);
  assert.throws(()=>exercise({...source(),receipt:{...record,classification:'verified-owned'}}),/ORIGIN_SIGNATURE_INVALID/);
});
test('rejects cross-program, cross-mission, cross-target and incorrect signer authority',()=>{
  for(const edit of [{programId:crypto.randomUUID()},{targetKey:'foreign'},
    {expectedMissionId:crypto.randomUUID()},{returnedMissionId:crypto.randomUUID()},
    {intentId:'organization:'+'a'.repeat(64)},{issuer:'untrusted'}]){
    assert.throws(()=>exercise(source({...record,...edit})),/ORIGIN_BINDING_MISMATCH|ORIGIN_ISSUER_MISMATCH/);
  }
  for(const edit of [{classification:'unresolved'},{evidenceDigest:'invalid'},
    {authorityGeneration:0},{providerSessionId:'fake'}])
    assert.throws(()=>exercise(source({...record,...edit})),/ORIGIN_INVALID|ORIGIN_CLASSIFICATION_INVALID/);
  assert.throws(()=>exercise(source({...record,extra:'claim'})),/ORIGIN_INVALID/);
});
test('replayed but still fresh signed receipt cannot satisfy a different request challenge',()=>{
  assert.throws(()=>exercise(source(),query,{challenge:'b'.repeat(64)}),/ORIGIN_CHALLENGE_MISMATCH/);
});
test('rejects expired, future, stale and unbounded lifetime authority',()=>{
  const t=ms=>new Date(now.getTime()+ms).toISOString();
  for(const edit of [{observedAt:t(-31000)},{observedAt:t(1000)},
    {validUntil:t(-100)},{validUntil:t(120000)}])
    assert.throws(()=>exercise(source({...record,...edit})),/ORIGIN_STALE/);
});
test('a denied or missing external provider lookup cannot mint a claim',async()=>{
  const sign=createSigner({requestToken:token,issuer,clock:()=>now,
    signerPrivateKey:privatePem(signer.privateKey),originPublicKey:publicPem(origin.publicKey),
    lookup:async()=>{throw new Error('PROVIDER_ORIGIN_UNAVAILABLE');}});
  await assert.rejects(sign(token,query),/PROVIDER_ORIGIN_UNAVAILABLE/);
  assert.throws(()=>authenticateToken(token,token+'x'),/REQUEST_UNAUTHORIZED/);
});
test('rejects non-Ed25519 source or signer and missing bearer authority',async()=>{
  const rsa=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>exercise(source(),query,{originPublicKey:publicPem(rsa.publicKey)}),/ORIGIN_SIGNATURE_INVALID/);
  assert.throws(()=>exercise(source(),query,{signerPrivateKey:privatePem(rsa.privateKey)}),/SIGNER_KEY_INVALID/);
  const sign=createSigner({requestToken:token,issuer,clock:()=>now,
    signerPrivateKey:privatePem(signer.privateKey),originPublicKey:publicPem(origin.publicKey),
    lookup:async()=>source()});
  await assert.rejects(sign('',query),/REQUEST_UNAUTHORIZED/);
});
