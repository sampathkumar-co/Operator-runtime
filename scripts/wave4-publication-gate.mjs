import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointCurrentCheckout } from './wave4-source-readiness.mjs';

export const REQUIRED_OWNER_GATES = Object.freeze([
  'three_lane_real_model_scoring',
  'fifty_held_out_real_user_workflows',
  'official_125_miniwob_supplement',
  'original_windows_chrome_edge_uia',
  'original_two_host_receipt_recovery',
  'independent_authority_and_no_replay',
  'signed_package_provenance_and_rollback',
  'owner_accepted_canary_and_stop',
  'post_release_telemetry_and_owner_publish'
]);
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
function fail(message) { throw new Error('WAVE4_PUBLICATION_DENIED: ' + message); }
function base64Bytes(value, label, maximum = 32 * 1024) {
  if (typeof value !== 'string' || value.length > maximum * 2 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(label + ' must be bounded Base64');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum ||
      bytes.toString('base64') !== value) fail(label + ' is not canonical Base64');
  return bytes;
}
export function validateOwnerApprovedPublication({
  readiness, signedJsonBase64, detachedSignatureBase64, publicKeyPem,
  expectedPinnedKeySha256, nowMs = Date.now()
}) {
  if (!readiness || readiness.totalTasks !== 134 || readiness.sourceChecklistPending !== 0 ||
      readiness.sourceChecklistAccepted !== 134 || readiness.releaseAuthorization !== 'NOT_GRANTED' ||
      !SHA.test(readiness.candidateSha)) {
    fail('full source workboard is not accepted or source identity is invalid');
  }
  const messageBytes = base64Bytes(signedJsonBase64, 'owner attestation JSON', 24 * 1024);
  const signature = base64Bytes(detachedSignatureBase64, 'owner signature', 256);
  if (signature.length !== 64 || typeof publicKeyPem !== 'string' ||
      publicKeyPem.length > 4096 || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    fail('explicit pinned Ed25519 owner release signer is missing');
  }
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); }
  catch { fail('invalid owner public key'); }
  const actualSpkiSha256 = crypto.createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' })).digest('hex');
  if (typeof expectedPinnedKeySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedPinnedKeySha256) ||
      actualSpkiSha256 !== expectedPinnedKeySha256) {
    fail('owner signer is not source-pinned or trust anchor is not enrolled');
  }
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, messageBytes, key, signature)) {
    fail('owner release attestation signature invalid');
  }
  let payload;
  try { payload = JSON.parse(messageBytes.toString('utf8')); }
  catch { fail('owner release attestation is not valid JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).sort().join(',') !== 'approval,candidateSha,expiresAtMs,gates,issuedAtMs,schemaVersion') {
    fail('owner release attestation shape invalid');
  }
  if (payload.schemaVersion !== 1 || payload.approval !== 'APPROVE_EXACT_SOURCE_RELEASE' ||
      payload.candidateSha !== readiness.candidateSha ||
      !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(payload.issuedAtMs) ||
      !Number.isSafeInteger(payload.expiresAtMs) ||
      nowMs < payload.issuedAtMs || payload.expiresAtMs <= nowMs ||
      payload.expiresAtMs - payload.issuedAtMs > 24 * 60 * 60 * 1000) {
    fail('owner release approval does not match exact source or valid 24h issuance window');
  }
  const gates = payload.gates;
  if (!gates || typeof gates !== 'object' || Array.isArray(gates) ||
      Object.keys(gates).sort().join(',') !== [...REQUIRED_OWNER_GATES].sort().join(',')) {
    fail('owner attestation must cover every independently reviewed gate');
  }
  for (const name of REQUIRED_OWNER_GATES) {
    const evidence = gates[name];
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
        Object.keys(evidence).sort().join(',') !== 'evidenceSha256,evidenceUri,status' ||
        evidence.status !== 'OWNER_SIGNED_PASS' || !DIGEST.test(evidence.evidenceSha256)) {
      fail(name + ' missing independently reviewed evidence digest');
    }
    let url;
    try { url = new URL(evidence.evidenceUri); }
    catch { fail(name + ' evidence URL invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        evidence.evidenceUri.length > 2048) fail(name + ' evidence must use credential-free HTTPS');
  }
  return {
    status: 'OWNER_SIGNED_SOURCE_MATCHED_ACCEPTANCE',
    candidateSha: readiness.candidateSha,
    gateCount: REQUIRED_OWNER_GATES.length,
    attestationSha256: crypto.createHash('sha256').update(messageBytes).digest('hex'),
    limitation: 'Signature authenticates the owner assertion and reviewed evidence references. It does not automatically replay physical tests, verify underlying linked artifacts, or substitute an independent auditor.'
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readiness = await checkpointCurrentCheckout({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN
  });
  const trust = JSON.parse(await fs.readFile(new URL('../certification/wave4-owner-key.json', import.meta.url), 'utf8'));
  if (trust.schemaVersion !== 1 || trust.status !== 'ENROLLED_AND_REVIEWED') {
    fail('release approval signer has not been enrolled in reviewed source');
  }
  const certified = validateOwnerApprovedPublication({
    readiness,
    signedJsonBase64: process.env.OPERATOR_WAVE4_RELEASE_ATTESTATION_B64,
    detachedSignatureBase64: process.env.OPERATOR_WAVE4_RELEASE_SIGNATURE_B64,
    publicKeyPem: process.env.OPERATOR_WAVE4_RELEASE_PUBLIC_KEY_PEM,
    expectedPinnedKeySha256: trust.publicKeySpkiSha256
  });
  process.stdout.write(JSON.stringify(certified) + '\n');
}
