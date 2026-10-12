// Independent provider-origin claim signer. Never accept a caller-supplied classification.
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9._:@/+=-]{1,256}$/;
const HEX = /^[0-9a-f]{64}$/;
const CLASSIFICATIONS = new Set(['verified-unrelated','verified-never-created','verified-owned']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const exactKeys = (input,allowed) => input && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).length === allowed.length
  && Object.keys(input).every(k => allowed.includes(k));
function value(input,pattern,code='ORIGIN_INVALID') {
  if (typeof input !== 'string' || !pattern.test(input)) fail(code);
  return input;
}
function timestamp(input) {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))
    || new Date(input).toISOString() !== input) fail('ORIGIN_TIME_INVALID');
  return Date.parse(input);
}
export function stableMissionId(programId,targetKey) {
  value(programId,UUID);value(targetKey,LABEL);
  const bytes = crypto.createHash('sha256').update('organization-mission\0'+programId+'\0'+targetKey,'utf8').digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
export function quarantineIntentId(programId,returnedMissionId) {
  value(programId,UUID);value(returnedMissionId,UUID);
  return 'organization:'+crypto.createHash('sha256')
    .update(programId+'\0reconcile-untrusted-team-identity\0'+returnedMissionId,'utf8').digest('hex');
}
export function validateQuery(input) {
  if (!exactKeys(input,['programId','targetKey','returnedMissionId'])) fail('REQUEST_INVALID');
  const {programId,targetKey,returnedMissionId}=input;
  value(programId,UUID,'REQUEST_INVALID');value(targetKey,LABEL,'REQUEST_INVALID');
  value(returnedMissionId,UUID,'REQUEST_INVALID');
  return {programId,targetKey,returnedMissionId};
}
export function authenticateToken(provided,expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected
    || provided.length !== expected.length || provided.length > 512
    || !crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected))) fail('REQUEST_UNAUTHORIZED');
}
export function signFromVerifiedObservation({query,challenge,originResponse,originPublicKey,signerPrivateKey,issuer,now=new Date()}) {
  const request=validateQuery(query);
  value(challenge,HEX,'ORIGIN_CHALLENGE_INVALID');
  const response=originResponse;
  if (!exactKeys(response,['receipt','signature']) || !response.receipt) fail('ORIGIN_INVALID');
  const r=response.receipt;
  const fields=['schemaVersion','issuer','challenge','intentId','programId','targetKey','expectedMissionId',
    'returnedMissionId','classification','evidenceDigest','providerDeviceId','providerProcessId',
    'providerSessionId','authorityGeneration','observedAt','validUntil'];
  if (!exactKeys(r,fields) || r.schemaVersion !== 1) fail('ORIGIN_INVALID');
  if (!issuer || r.issuer !== issuer) fail('ORIGIN_ISSUER_MISMATCH');
  if (r.challenge !== challenge) fail('ORIGIN_CHALLENGE_MISMATCH');
  if (r.programId !== request.programId || r.targetKey !== request.targetKey
    || r.returnedMissionId !== request.returnedMissionId
    || r.expectedMissionId !== stableMissionId(request.programId,request.targetKey)
    || r.intentId !== quarantineIntentId(request.programId,request.returnedMissionId))
    fail('ORIGIN_BINDING_MISMATCH');
  if (!CLASSIFICATIONS.has(r.classification)) fail('ORIGIN_CLASSIFICATION_INVALID');
  value(r.evidenceDigest,HEX);value(r.providerDeviceId,UUID);
  value(r.providerProcessId,LABEL);value(r.providerSessionId,UUID);
  if (!Number.isSafeInteger(r.authorityGeneration) || r.authorityGeneration < 1) fail('ORIGIN_INVALID');
  const issued=timestamp(r.observedAt),expires=timestamp(r.validUntil),clock=now.getTime();
  if (issued > clock || clock-issued > 30000 || expires <= clock || expires-issued > 60000) fail('ORIGIN_STALE');
  if (typeof response.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(response.signature))
    fail('ORIGIN_SIGNATURE_INVALID');
  let upstream;
  try { upstream=crypto.createPublicKey(originPublicKey); }
  catch { fail('ORIGIN_SIGNATURE_INVALID'); }
  if (upstream.asymmetricKeyType !== 'ed25519'
    || !crypto.verify(null,Buffer.from(JSON.stringify(r),'utf8'),upstream,Buffer.from(response.signature,'base64url')))
    fail('ORIGIN_SIGNATURE_INVALID');
  let signer;
  try { signer=crypto.createPrivateKey(signerPrivateKey); }
  catch { fail('SIGNER_KEY_INVALID'); }
  if (signer.asymmetricKeyType !== 'ed25519') fail('SIGNER_KEY_INVALID');
  // Exact field order matches the adjudicator's JSON.stringify(claim) Ed25519 verification.
  const claim={schemaVersion:1,intentId:r.intentId,programId:r.programId,targetKey:r.targetKey,
    expectedMissionId:r.expectedMissionId,returnedMissionId:r.returnedMissionId,
    classification:r.classification,evidenceDigest:r.evidenceDigest,providerDeviceId:r.providerDeviceId,
    providerProcessId:r.providerProcessId,providerSessionId:r.providerSessionId,
    authorityGeneration:r.authorityGeneration,issuedAt:now.toISOString(),
    expiresAt:new Date(Math.min(clock+60000,expires)).toISOString()};
  return {claim,signature:crypto.sign(null,Buffer.from(JSON.stringify(claim),'utf8'),signer).toString('base64url')};
}
export function createSigner({requestToken,lookup,originPublicKey,signerPrivateKey,issuer,clock=()=>new Date()}) {
  if (typeof lookup !== 'function' || !requestToken || !issuer) fail('SIGNER_CONFIG_INVALID');
  return async (token,input) => {
    authenticateToken(token,requestToken);
    const query=validateQuery(input);
    // Require a fresh independently signed lookup on every request: no caller-supplied origin, fallback or cached proof.
    // Unpredictable per-call challenge prevents reuse of a still-fresh provider receipt.
    const challenge=crypto.randomBytes(32).toString('hex');
    const originResponse=await lookup({...query,challenge});
    return signFromVerifiedObservation({query,challenge,originResponse,originPublicKey,signerPrivateKey,issuer,now:clock()});
  };
}
