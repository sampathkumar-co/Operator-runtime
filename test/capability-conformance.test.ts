import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capabilityManifestDigest,
  type CapabilityExtensionManifest
} from '../src/core/capability-sdk.ts';
import {
  certifyCapabilityExtension,
  createCapabilityConformanceReceipt,
  createCapabilityRevocation,
  evaluateCapabilityAdmission,
  validateCapabilityConformanceReceipt
} from '../src/core/capability-conformance.ts';

const manifest: CapabilityExtensionManifest = {
  sdkVersion: 1,
  id: 'example.safe-files',
  version: '1.0.0',
  displayName: 'Safe Files',
  vendor: 'Example',
  capabilities: [{
    capability: 'file.read',
    risk: 'read',
    deterministic: true,
    reversible: true,
    verification: 'runtime',
    resourceKinds: ['file']
  }]
};

function receipts(manifestDigest = capabilityManifestDigest(manifest)) {
  const at = '2026-10-06T00:00:00.000Z';
  return [
    createCapabilityConformanceReceipt({
      suite: 'SANDBOX',
      manifestDigest,
      verifierId: 'sandbox-verifier',
      independent: true,
      passed: true,
      evidenceArtifactIds: ['1'.repeat(64)],
      observedAt: at
    }),
    createCapabilityConformanceReceipt({
      suite: 'CONTRACT',
      manifestDigest,
      verifierId: 'contract-verifier',
      independent: true,
      passed: true,
      evidenceArtifactIds: ['2'.repeat(64)],
      observedAt: at
    }),
    createCapabilityConformanceReceipt({
      suite: 'ADVERSARIAL',
      manifestDigest,
      verifierId: 'red-team-verifier',
      independent: true,
      passed: true,
      evidenceArtifactIds: ['3'.repeat(64)],
      observedAt: at
    }),
    createCapabilityConformanceReceipt({
      suite: 'PERFORMANCE',
      manifestDigest,
      verifierId: 'perf-verifier',
      independent: true,
      passed: true,
      evidenceArtifactIds: ['4'.repeat(64)],
      observedAt: at,
      metrics: {
        p95LatencyMs: 25,
        failureRate: 0.001,
        peakMemoryMb: 64
      }
    })
  ];
}

test('capability certification requires complete independent evidence and admits exact certified manifest', () => {
  const certification = certifyCapabilityExtension({
    manifest,
    receipts: receipts(),
    policy: {
      maxP95LatencyMs: 100,
      maxFailureRate: 0.01,
      maxPeakMemoryMb: 128
    },
    certifiedAt: '2026-10-06T00:01:00.000Z'
  });

  assert.equal(certification.status, 'CERTIFIED');
  assert.deepEqual(certification.reasons, []);
  assert.match(certification.id, /^[0-9a-f]{64}$/);

  const decision = evaluateCapabilityAdmission(certification, []);
  assert.deepEqual(decision, {
    allowed: true,
    reason: 'CERTIFIED',
    certificationId: certification.id
  });
});

test('missing required suite rejects certification instead of silently weakening the gate', () => {
  const certification = certifyCapabilityExtension({
    manifest,
    receipts: receipts().filter((receipt) => receipt.suite !== 'ADVERSARIAL'),
    certifiedAt: '2026-10-06T00:01:00.000Z'
  });

  assert.equal(certification.status, 'REJECTED');
  assert.ok(certification.reasons.includes('ADVERSARIAL:MISSING'));
  assert.equal(evaluateCapabilityAdmission(certification, []).allowed, false);
});

test('manifest lineage mismatch and non-independent verification both reject promotion', () => {
  const items = receipts();
  items[0] = createCapabilityConformanceReceipt({
    suite: 'SANDBOX',
    manifestDigest: 'f'.repeat(64),
    verifierId: 'sandbox-verifier',
    independent: false,
    passed: true,
    evidenceArtifactIds: ['1'.repeat(64)],
    observedAt: '2026-10-06T00:00:00.000Z'
  });

  const certification = certifyCapabilityExtension({
    manifest,
    receipts: items,
    certifiedAt: '2026-10-06T00:01:00.000Z'
  });

  assert.equal(certification.status, 'REJECTED');
  assert.ok(certification.reasons.includes('SANDBOX:MANIFEST_DIGEST_MISMATCH'));
  assert.ok(certification.reasons.includes('SANDBOX:NOT_INDEPENDENT'));
});

test('performance policy is an explicit certification gate', () => {
  const items = receipts();
  const performanceIndex = items.findIndex((receipt) => receipt.suite === 'PERFORMANCE');
  items[performanceIndex] = createCapabilityConformanceReceipt({
    suite: 'PERFORMANCE',
    manifestDigest: capabilityManifestDigest(manifest),
    verifierId: 'perf-verifier',
    independent: true,
    passed: true,
    evidenceArtifactIds: ['4'.repeat(64)],
    observedAt: '2026-10-06T00:00:00.000Z',
    metrics: {
      p95LatencyMs: 500,
      failureRate: 0.2,
      peakMemoryMb: 1024
    }
  });

  const certification = certifyCapabilityExtension({
    manifest,
    receipts: items,
    policy: {
      maxP95LatencyMs: 100,
      maxFailureRate: 0.01,
      maxPeakMemoryMb: 128
    },
    certifiedAt: '2026-10-06T00:01:00.000Z'
  });

  assert.equal(certification.status, 'REJECTED');
  assert.ok(certification.reasons.includes('PERFORMANCE:P95_EXCEEDED'));
  assert.ok(certification.reasons.includes('PERFORMANCE:FAILURE_RATE_EXCEEDED'));
  assert.ok(certification.reasons.includes('PERFORMANCE:MEMORY_EXCEEDED'));
});

test('revocation overrides a previously valid certification', () => {
  const certification = certifyCapabilityExtension({
    manifest,
    receipts: receipts(),
    certifiedAt: '2026-10-06T00:01:00.000Z'
  });
  const revocation = createCapabilityRevocation({
    certificationId: certification.id,
    manifestDigest: certification.manifestDigest,
    reasonCode: 'VULNERABILITY_CONFIRMED',
    evidenceArtifactIds: ['9'.repeat(64)],
    revokedAt: '2026-10-06T00:02:00.000Z'
  });

  const decision = evaluateCapabilityAdmission(certification, [revocation]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'REVOKED');
  assert.equal(decision.revocationId, revocation.id);
});

test('tampered conformance receipt fails closed', () => {
  const receipt = receipts()[0]!;
  const tampered = structuredClone(receipt);
  tampered.verifierId = 'forged-verifier';
  assert.throws(() => validateCapabilityConformanceReceipt(tampered), /id does not match/);
});
