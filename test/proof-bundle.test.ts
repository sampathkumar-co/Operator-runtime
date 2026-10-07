import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  createMachineVerifiableProofBundle,
  createProofBundleClaim,
  signMachineVerifiableProofBundle,
  verifyMachineVerifiableProofBundle
} from '../src/core/proof-bundle.ts';

const artifact = 'a'.repeat(64);

test('proof bundles keep inference distinct from proof', () => {
  const inferred = createProofBundleClaim({
    statement: 'Deployment is safe.',
    required: true,
    inferred: true,
    evidence: [{ artifactId: artifact, evidenceClass: 'MODEL_INFERENCE', passed: true, independent: false }]
  });
  assert.equal(inferred.decision.level, 'INFERRED');
  const bundle = createMachineVerifiableProofBundle({
    objectiveId: 'objective:1',
    authorityDigest: '1'.repeat(64),
    planDigest: '2'.repeat(64),
    effectJournalDigest: '3'.repeat(64),
    evidencePackId: '4'.repeat(64),
    claims: [inferred],
    rollbackStatus: 'AVAILABLE',
    createdAt: '2026-10-07T00:00:00.000Z'
  });
  const result = verifyMachineVerifiableProofBundle(bundle);
  assert.equal(result.status, 'INVALID');
  assert.ok(result.reasons.includes('REQUIRED_CLAIM_UNPROVEN'));
});

test('independently proven signed bundle verifies outside the executing runtime', () => {
  const claim = createProofBundleClaim({
    statement: 'Policy preconditions are satisfied.',
    required: true,
    evidence: [
      { artifactId: 'b'.repeat(64), evidenceClass: 'DETERMINISTIC_POLICY', passed: true, independent: true }
    ]
  });
  assert.equal(claim.decision.level, 'PROVEN');
  const bundle = createMachineVerifiableProofBundle({
    objectiveId: 'objective:release',
    authorityDigest: '1'.repeat(64),
    planDigest: '2'.repeat(64),
    effectJournalDigest: '3'.repeat(64),
    evidencePackId: '4'.repeat(64),
    claims: [claim],
    residualUncertainty: [],
    rollbackStatus: 'NOT_REQUIRED',
    createdAt: '2026-10-07T00:00:00.000Z'
  });
  const unsigned = verifyMachineVerifiableProofBundle(bundle);
  assert.equal(unsigned.status, 'UNSIGNED');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signed = signMachineVerifiableProofBundle(bundle, {
    keyId: 'release-key-1',
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  });
  const verified = verifyMachineVerifiableProofBundle(signed, {
    'release-key-1': publicKey.export({ format: 'pem', type: 'spki' }).toString()
  });
  assert.equal(verified.status, 'VALID');
  assert.equal(verified.signatureVerified, true);

  const tampered = structuredClone(signed);
  tampered.rollbackStatus = 'FAILED';
  const rejected = verifyMachineVerifiableProofBundle(tampered, {
    'release-key-1': publicKey.export({ format: 'pem', type: 'spki' }).toString()
  });
  assert.equal(rejected.status, 'INVALID');
  assert.ok(rejected.reasons.includes('BUNDLE_DIGEST_MISMATCH'));
});
