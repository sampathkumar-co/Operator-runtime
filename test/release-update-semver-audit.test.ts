import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ReleaseUpdateVerifier, signReleaseManifest, type ReleaseManifest } from '../src/core/release-update.ts';

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  };
}

function manifest(version: string, channel: 'stable' | 'beta' = 'stable'): ReleaseManifest {
  const bytes = Buffer.from('semver-audit-artifact');
  return {
    schemaVersion: 1,
    product: 'operator-runtime',
    channel,
    version,
    publishedAt: '2026-09-10T00:00:00.000Z',
    artifacts: [{
      platform: 'win32',
      arch: 'x64',
      kind: 'msix',
      url: 'https://releases.example.invalid/operator.msix',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength
    }]
  };
}

test('release ordering remains exact beyond Number.MAX_SAFE_INTEGER', () => {
  const release = keys();
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  const signed = signReleaseManifest(manifest('9007199254740993.0.0'), release.privateKey);

  const verified = verifier.verifySignedManifest(signed, {
    channel: 'stable',
    currentVersion: '9007199254740992.0.0',
    now: new Date('2026-09-10T00:01:00.000Z')
  });

  assert.equal(verified.version, '9007199254740993.0.0');
});

test('numeric prerelease ordering remains exact for arbitrarily large identifiers', () => {
  const release = keys();
  const verifier = new ReleaseUpdateVerifier(release.publicKey);
  const signed = signReleaseManifest(manifest('1.0.0-beta.9007199254740993', 'beta'), release.privateKey);

  const verified = verifier.verifySignedManifest(signed, {
    channel: 'beta',
    currentVersion: '1.0.0-beta.9007199254740992',
    now: new Date('2026-09-10T00:01:00.000Z')
  });

  assert.equal(verified.version, '1.0.0-beta.9007199254740993');
});

test('numeric prerelease identifiers with leading zeroes are rejected', () => {
  const release = keys();
  assert.throws(
    () => signReleaseManifest(manifest('1.0.0-beta.01', 'beta'), release.privateKey),
    (error: any) => error?.code === 'UPDATE_VERSION_INVALID'
  );
});
