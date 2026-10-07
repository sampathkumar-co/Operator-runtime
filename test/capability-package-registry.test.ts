import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  certifyCapabilityExtension,
  createCapabilityConformanceReceipt,
  createCapabilityRevocation
} from '../src/core/capability-conformance.ts';
import {
  admitCapabilityPackage,
  signCapabilityPackage
} from '../src/core/capability-package-registry.ts';

const manifest = {
  sdkVersion: 1 as const,
  id: 'example.inspect',
  version: '1.0.0',
  displayName: 'Example Inspect',
  provenance: { source: 'https://example.invalid/source', packageDigest: 'a'.repeat(64) },
  capabilities: [{
    capability: 'filesystem.read',
    risk: 'read' as const,
    deterministic: true,
    reversible: true,
    verification: 'runtime' as const,
    reconciliation: 'not-required' as const,
    inputSchemaVersion: 1 as const,
    inputMaxBytes: 4096,
    outputMaxBytes: 4096,
    cancellation: 'required' as const,
    resourceKinds: ['file']
  }]
};

function certification() {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex');
  // Use the runtime's canonical manifest digest instead of JSON ordering assumptions.
  const receipts = ['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE'].map((suite, index) =>
    createCapabilityConformanceReceipt({
      suite: suite as any,
      manifestDigest: index === -1 ? digest : '',
      verifierId: 'verifier:independent',
      independent: true,
      passed: true,
      evidenceArtifactIds: [String(index + 1).repeat(64)],
      observedAt: '2026-10-07T00:00:00.000Z',
      ...(suite === 'PERFORMANCE' ? { metrics: { p95LatencyMs: 10, failureRate: 0, peakMemoryMb: 16 } } : {})
    })
  );
  return receipts;
}

test('signed capability registry admits only independently certified exact manifests', async () => {
  const { capabilityManifestDigest } = await import('../src/core/capability-sdk.ts');
  const digest = capabilityManifestDigest(manifest);
  const receipts = ['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE'].map((suite, index) =>
    createCapabilityConformanceReceipt({
      suite: suite as any,
      manifestDigest: digest,
      verifierId: 'verifier:independent',
      independent: true,
      passed: true,
      evidenceArtifactIds: [String(index + 1).repeat(64)],
      observedAt: '2026-10-07T00:00:00.000Z',
      ...(suite === 'PERFORMANCE' ? { metrics: { p95LatencyMs: 10, failureRate: 0, peakMemoryMb: 16 } } : {})
    })
  );
  const cert = certifyCapabilityExtension({
    manifest,
    receipts,
    certifiedAt: '2026-10-07T00:01:00.000Z'
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pkg = signCapabilityPackage({
    publisherId: 'publisher:acme',
    manifest,
    certification: cert,
    publishedAt: '2026-10-07T00:02:00.000Z',
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  });
  const publisher = {
    id: 'publisher:acme',
    displayName: 'Acme',
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    enabled: true
  };
  const admitted = admitCapabilityPackage({ package: pkg, publishers: [publisher] });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.reason, 'ADMITTED');

  const revoked = createCapabilityRevocation({
    certificationId: cert.id,
    manifestDigest: cert.manifestDigest,
    reasonCode: 'VULNERABILITY',
    evidenceArtifactIds: ['f'.repeat(64)],
    revokedAt: '2026-10-07T00:03:00.000Z'
  });
  const denied = admitCapabilityPackage({ package: pkg, publishers: [publisher], revocations: [revoked] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'REVOKED');
});

test('publisher signature and enablement are fail-closed', async () => {
  const { capabilityManifestDigest } = await import('../src/core/capability-sdk.ts');
  const digest = capabilityManifestDigest(manifest);
  const receipt = (suite: any, digit: string) => createCapabilityConformanceReceipt({
    suite,
    manifestDigest: digest,
    verifierId: 'verifier:independent',
    independent: true,
    passed: true,
    evidenceArtifactIds: [digit.repeat(64)],
    observedAt: '2026-10-07T00:00:00.000Z',
    ...(suite === 'PERFORMANCE' ? { metrics: { p95LatencyMs: 10 } } : {})
  });
  const cert = certifyCapabilityExtension({
    manifest,
    receipts: [receipt('SANDBOX','1'), receipt('CONTRACT','2'), receipt('ADVERSARIAL','3'), receipt('PERFORMANCE','4')],
    certifiedAt: '2026-10-07T00:01:00.000Z'
  });
  const one = crypto.generateKeyPairSync('ed25519');
  const two = crypto.generateKeyPairSync('ed25519');
  const pkg = signCapabilityPackage({
    publisherId: 'publisher:acme',
    manifest,
    certification: cert,
    publishedAt: '2026-10-07T00:02:00.000Z',
    privateKeyPem: one.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  });
  const wrongKey = admitCapabilityPackage({
    package: pkg,
    publishers: [{
      id: 'publisher:acme',
      displayName: 'Acme',
      publicKeyPem: two.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      enabled: true
    }]
  });
  assert.equal(wrongKey.allowed, false);
  assert.equal(wrongKey.reason, 'SIGNATURE_INVALID');

  const disabled = admitCapabilityPackage({
    package: pkg,
    publishers: [{
      id: 'publisher:acme',
      displayName: 'Acme',
      publicKeyPem: one.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      enabled: false
    }]
  });
  assert.equal(disabled.reason, 'PUBLISHER_DISABLED');
});
