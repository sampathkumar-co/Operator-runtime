import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseUpdateVerifier, signReleaseManifest, type ReleaseManifest } from '../src/core/release-update.ts';

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
}

function manifest(bytes: Buffer, overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    schemaVersion: 1,
    product: 'operator-runtime',
    channel: 'stable',
    version: '1.1.0',
    publishedAt: '2026-09-09T12:00:00.000Z',
    artifacts: [{
      platform: 'win32',
      arch: 'x64',
      kind: 'msix',
      url: 'https://releases.example.invalid/operator-1.1.0-x64.msix',
      sha256,
      sizeBytes: bytes.byteLength
    }],
    ...overrides
  };
}

async function temp(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('signed release manifest verifies with the pinned Ed25519 key and rejects tampering or a different key', () => {
  const release = keys();
  const attacker = keys();
  const bytes = Buffer.from('signed-msix-payload');
  const signed = signReleaseManifest(manifest(bytes), release.privateKey);
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  const verified = verifier.verifySignedManifest(signed, {
    channel: 'stable', currentVersion: '1.0.0', now: new Date('2026-09-09T12:01:00.000Z')
  });
  assert.equal(verified.version, '1.1.0');

  const tampered = structuredClone(signed);
  tampered.manifest.version = '1.2.0';
  assert.throws(
    () => verifier.verifySignedManifest(tampered, { channel: 'stable', currentVersion: '1.0.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_SIGNATURE_INVALID'
  );

  const wrongVerifier = new ReleaseUpdateVerifier(attacker.publicKey);
  assert.throws(
    () => wrongVerifier.verifySignedManifest(signed, { channel: 'stable', currentVersion: '1.0.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_SIGNATURE_INVALID'
  );
});

test('update verification rejects downgrade, channel mismatch, stable prerelease, and future-dated manifests', () => {
  const release = keys();
  const bytes = Buffer.from('payload');
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  const stable = signReleaseManifest(manifest(bytes), release.privateKey);

  assert.throws(
    () => verifier.verifySignedManifest(stable, { channel: 'stable', currentVersion: '1.1.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_NOT_NEWER'
  );
  assert.throws(
    () => verifier.verifySignedManifest(stable, { channel: 'beta', currentVersion: '1.0.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_CHANNEL_MISMATCH'
  );

  const stablePrerelease = signReleaseManifest(manifest(bytes, { version: '1.2.0-beta.1' }), release.privateKey);
  assert.throws(
    () => verifier.verifySignedManifest(stablePrerelease, { channel: 'stable', currentVersion: '1.1.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_CHANNEL_MISMATCH'
  );

  const future = signReleaseManifest(manifest(bytes, { publishedAt: '2026-09-10T12:00:00.000Z' }), release.privateKey);
  assert.throws(
    () => verifier.verifySignedManifest(future, { channel: 'stable', currentVersion: '1.0.0', now: new Date('2026-09-09T12:01:00.000Z') }),
    (error: any) => error?.code === 'UPDATE_MANIFEST_FUTURE'
  );
});

test('SemVer prerelease numeric identifiers use numeric precedence', () => {
  const release = keys();
  const bytes = Buffer.from('beta-payload');
  const beta = signReleaseManifest(manifest(bytes, { channel: 'beta', version: '1.0.0-beta.10' }), release.privateKey);
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  assert.equal(verifier.verifySignedManifest(beta, {
    channel: 'beta', currentVersion: '1.0.0-beta.2', now: new Date('2026-09-09T12:01:00.000Z')
  }).version, '1.0.0-beta.10');
});

test('release manifests refuse insecure or credential-bearing artifact URLs', () => {
  const release = keys();
  const bytes = Buffer.from('payload');
  const base = manifest(bytes);
  const insecure = structuredClone(base);
  insecure.artifacts[0]!.url = 'http://releases.example.invalid/operator.msix';
  assert.throws(() => signReleaseManifest(insecure, release.privateKey), (error: any) => error?.code === 'UPDATE_URL_INVALID');

  const credentialed = structuredClone(base);
  credentialed.artifacts[0]!.url = 'https://user:pass@releases.example.invalid/operator.msix';
  assert.throws(() => signReleaseManifest(credentialed, release.privateKey), (error: any) => error?.code === 'UPDATE_URL_INVALID');
});

test('artifact selection is deterministic and staging verifies size/hash, is idempotent, and refuses conflicts', async (t) => {
  const release = keys();
  const state = await temp(t);
  const bytes = Buffer.from('real-msix-bytes');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const releaseManifest: ReleaseManifest = {
    schemaVersion: 1,
    product: 'operator-runtime',
    channel: 'stable',
    version: '2.0.0',
    publishedAt: '2026-09-09T12:00:00.000Z',
    artifacts: [
      { platform: 'win32', arch: 'x64', kind: 'zip', url: 'https://releases.example.invalid/operator.zip', sha256, sizeBytes: bytes.byteLength },
      { platform: 'win32', arch: 'x64', kind: 'msix', url: 'https://releases.example.invalid/operator.msix', sha256, sizeBytes: bytes.byteLength }
    ]
  };
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  const selected = verifier.selectArtifact(releaseManifest, { platform: 'win32', arch: 'x64' });
  assert.equal(selected.kind, 'msix');

  const staged = await verifier.verifyAndStageArtifact(selected, bytes, state, '2.0.0');
  assert.equal(staged.sha256, sha256);
  assert.deepEqual(await fs.readFile(staged.path), bytes);
  const again = await verifier.verifyAndStageArtifact(selected, bytes, state, '2.0.0');
  assert.equal(again.path, staged.path);

  await assert.rejects(
    verifier.verifyAndStageArtifact({ ...selected, sizeBytes: bytes.byteLength + 1 }, bytes, state, '2.0.0'),
    (error: any) => error?.code === 'UPDATE_SIZE_MISMATCH'
  );
  await assert.rejects(
    verifier.verifyAndStageArtifact({ ...selected, sha256: '0'.repeat(64) }, bytes, state, '2.0.0'),
    (error: any) => error?.code === 'UPDATE_HASH_MISMATCH'
  );

  await fs.writeFile(staged.path, Buffer.from('tampered-staged-file'));
  await assert.rejects(
    verifier.verifyAndStageArtifact(selected, bytes, state, '2.0.0'),
    (error: any) => error?.code === 'UPDATE_STAGE_CONFLICT'
  );
});
