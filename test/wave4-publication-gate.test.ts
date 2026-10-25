import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { REQUIRED_OWNER_GATES, validateOwnerApprovedPublication } from '../scripts/wave4-publication-gate.mjs';

const sha = 'a'.repeat(40);
const now = 2_000_000;
const keys = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const expectedPinnedKeySha256 = crypto.createHash('sha256')
  .update(keys.publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
const readiness = {
  totalTasks: 134, sourceChecklistAccepted: 134, sourceChecklistPending: 0,
  candidateSha: sha, releaseAuthorization: 'NOT_GRANTED'
};
function envelope() {
  return {
    schemaVersion: 1, approval: 'APPROVE_EXACT_SOURCE_RELEASE', candidateSha: sha,
    issuedAtMs: now - 1000, expiresAtMs: now + 60_000,
    gates: Object.fromEntries(REQUIRED_OWNER_GATES.map(name => [name, {
      status: 'OWNER_SIGNED_PASS',
      evidenceUri: 'https://github.com/sampathkumar-co/Operator-runtime/actions/runs/1234',
      evidenceSha256: 'c'.repeat(64)
    }]))
  };
}
function sign(payload = envelope(), key = keys.privateKey) {
  const serialized = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    signedJsonBase64: serialized.toString('base64'),
    detachedSignatureBase64: crypto.sign(null, serialized, key).toString('base64')
  };
}
function verify(input: any = {}) {
  return validateOwnerApprovedPublication({
    readiness, publicKeyPem, expectedPinnedKeySha256, nowMs: now, ...sign(), ...input
  });
}
test('C11 requires all 134 accepted source checklist items before any owner assertion is considered', () => {
  for (const candidate of [
    { ...readiness, sourceChecklistPending: 1, sourceChecklistAccepted: 133 },
    { ...readiness, candidateSha: 'b'.repeat(40) },
    { ...readiness, totalTasks: 133 }
  ]) {
    assert.throws(() => verify({ readiness: candidate }),
      /full source workboard/);
  }
});
test('C11 exact-SHA one-day Ed25519 signed owner release claim can be authenticated but not replay external proofs', () => {
  const result = verify();
  assert.equal(result.status, 'OWNER_SIGNED_SOURCE_MATCHED_ACCEPTANCE');
  assert.equal(result.candidateSha, sha);
  assert.equal(result.gateCount, 9);
  assert.match(result.attestationSha256, /^[a-f0-9]{64}$/);
  assert.match(result.limitation, /does not automatically replay physical tests/);
});
test('C11 revoked signer, corrupted signature, incomplete evidence and forged source fail closed', () => {
  const attacker = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => verify(sign(envelope(), attacker)), /signature invalid/);
  const altered = envelope();
  altered.candidateSha = 'b'.repeat(40);
  assert.throws(() => verify(sign(altered)), /does not match exact source/);
  const missing = envelope();
  delete (missing.gates as Record<string, unknown>).original_two_host_receipt_recovery;
  assert.throws(() => verify(sign(missing)), /cover every/);
  const fake = envelope();
  fake.gates.original_windows_chrome_edge_uia.status = 'NOT_RUN';
  assert.throws(() => verify(sign(fake)), /missing independently reviewed evidence/);
  const http = envelope();
  http.gates.original_two_host_receipt_recovery.evidenceUri = 'http://example.com/x';
  assert.throws(() => verify(sign(http)), /credential-free HTTPS/);
});
test('C11 expired, future, overlong and wrong-source owner approval cannot release', () => {
  const expired = envelope();
  expired.expiresAtMs = now - 1;
  assert.throws(() => verify(sign(expired)), /valid 24h issuance window/);
  const future = envelope();
  future.issuedAtMs = now + 1;
  assert.throws(() => verify(sign(future)), /valid 24h issuance window/);
  const overlong = envelope();
  overlong.expiresAtMs = overlong.issuedAtMs + 25 * 60 * 60 * 1000;
  assert.throws(() => verify(sign(overlong)), /valid 24h issuance window/);
  assert.throws(() => verify({ publicKeyPem: 'not a key' }), /signer is missing/);
});

test('C11 a valid owner signature is still denied if source reviewer has not pinned its public key', () => {
  assert.throws(() => verify({ expectedPinnedKeySha256: null }),
    /owner signer is not source-pinned/);
  assert.throws(() => verify({ expectedPinnedKeySha256: 'f'.repeat(64) }),
    /owner signer is not source-pinned/);
});
