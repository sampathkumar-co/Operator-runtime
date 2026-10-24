import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  FROZEN_RELEASE, REQUIRED_NATIVE, verifyPublishedRelease
} from '../scripts/wave0-registry-artifact.mjs';

function makeInput() {
  const tarballBytes = Buffer.from('published-test-tarball-opaque-bytes');
  const sha1 = crypto.createHash('sha1').update(tarballBytes).digest('hex');
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tarballBytes).digest('base64');
  return {
    tarballBytes,
    registryDist: { shasum: sha1, integrity },
    packedMetadata: { shasum: sha1, integrity },
    packageJson: { name: FROZEN_RELEASE.name, version: FROZEN_RELEASE.version },
    runtimeManifest: { sourceCommit: FROZEN_RELEASE.sourceCommit, version: FROZEN_RELEASE.version },
    nativeHelpers: Object.fromEntries(REQUIRED_NATIVE.map((p, i) =>
      [p, Buffer.from('mock-win-binary-' + i)])),
    members: [
      'package/package.json', 'package/bin/operator.mjs',
      'package/runtime/runtime-manifest.json',
      'package/runtime/app/apps/local-agent/src/remote.js',
      ...REQUIRED_NATIVE.map(p => 'package/' + p)
    ]
  };
}
test('published bytes, embedded claim and three native helper hashes are distinct evidence layers', () => {
  const result = verifyPublishedRelease(makeInput());
  assert.equal(result.registryTarball.status, 'REGISTRY_BYTES_VERIFIED');
  assert.equal(result.embeddedSourceClaim.status,
    'MATCHES_DECLARED_GIT_SHA_NOT_REPRODUCIBLE_BUILD_PROOF');
  assert.equal(result.originalWindowsInstalledRuntime, 'NOT_RUN');
  assert.equal(result.separatelyRebuiltSourceEquivalence, 'NOT_VERIFIED');
  assert.equal(Object.keys(result.nativeHelperPublishedBytes.sha256).length, 3);
  assert.match(result.registryTarball.sha256, /^[a-f0-9]{64}$/);
});
test('tampered downloaded bytes or registry metadata fail closed', () => {
  const fixture = makeInput();
  assert.throws(() => verifyPublishedRelease({ ...fixture,
    tarballBytes: Buffer.from('altered-tarball') }), /registry SHA-1/);
  assert.throws(() => verifyPublishedRelease({ ...fixture,
    registryDist: { ...fixture.registryDist, integrity: 'sha512-invalid' } }), /SHA-512/);
});
test('source-commit self assertion mismatch is explicitly rejected', () => {
  const fixture = makeInput();
  assert.throws(() => verifyPublishedRelease({ ...fixture,
    runtimeManifest: { ...fixture.runtimeManifest, sourceCommit: '0'.repeat(40) }
  }), /source claim mismatches/);
});
test('missing helpers and missing package runtime entrypoint cannot look like complete artifact proof', () => {
  const fixture = makeInput();
  const nativeHelpers = { ...fixture.nativeHelpers };
  delete nativeHelpers[REQUIRED_NATIVE[2]];
  assert.throws(() => verifyPublishedRelease({ ...fixture, nativeHelpers }), /native helper bytes missing/);
  assert.throws(() => verifyPublishedRelease({ ...fixture,
    members: fixture.members.filter(p => p !== 'package/bin/operator.mjs')
  }), /missing published runtime file/);
});
test('registry proof cannot silently attribute a different npm package/version to release 2.0.6', () => {
  const fixture = makeInput();
  assert.throws(() => verifyPublishedRelease({ ...fixture,
    packageJson: { name: 'mecord-connect', version: '2.0.7' }
  }), /name\/version/);
});
