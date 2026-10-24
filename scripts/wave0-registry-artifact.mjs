import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FROZEN_RELEASE = Object.freeze({
  name: 'mecord-connect',
  version: '2.0.6',
  sourceCommit: 'b9682da964b8dfcda9b4ce65e1ba6352623bf7a5'
});
export const REQUIRED_NATIVE = Object.freeze([
  'runtime/native/operator-windows-dpapi.exe',
  'runtime/native/operator-windows-uia.exe',
  'runtime/native/operator-windows-path-lease.exe'
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
function requireState(condition, message) {
  if (!condition) throw new Error('WAVE0_REGISTRY_EVIDENCE_INVALID: ' + message);
}

/** This checks independently fetched registry BYTES and their internal metadata.
 * A matching embedded source-commit assertion is NOT independent reproducible-build proof.
 * Nothing in this verifier executes an installed package or touches user/local-agent state. */
export function verifyPublishedRelease({ registryDist, packedMetadata, tarballBytes,
  packageJson, runtimeManifest, nativeHelpers, members }) {
  requireState(Buffer.isBuffer(tarballBytes) && tarballBytes.length > 0, 'published tarball bytes missing');
  requireState(registryDist && typeof registryDist === 'object', 'registry dist metadata missing');
  const actualSha1 = sha1(tarballBytes);
  const actualIntegrity = integrity(tarballBytes);
  requireState(registryDist.shasum === actualSha1, 'registry SHA-1 does not match downloaded tarball');
  requireState(registryDist.integrity === actualIntegrity, 'registry SHA-512 integrity does not match downloaded tarball');
  requireState(packedMetadata && packedMetadata.shasum === actualSha1 &&
    packedMetadata.integrity === actualIntegrity, 'npm pack metadata disagrees with tarball');
  requireState(packageJson?.name === FROZEN_RELEASE.name &&
    packageJson?.version === FROZEN_RELEASE.version, 'unexpected packaged npm name/version');
  requireState(runtimeManifest?.sourceCommit === FROZEN_RELEASE.sourceCommit,
    'embedded runtime source claim mismatches frozen Git release');
  requireState(runtimeManifest?.version === FROZEN_RELEASE.version, 'embedded runtime version differs from npm package');
  requireState(Array.isArray(members) && new Set(members).size === members.length, 'invalid tar member census');
  const required = [
    'package/package.json', 'package/bin/operator.mjs',
    'package/runtime/runtime-manifest.json',
    'package/runtime/app/apps/local-agent/src/remote.js',
    ...REQUIRED_NATIVE.map(x => 'package/' + x)
  ];
  for (const p of required) requireState(members.includes(p), 'missing published runtime file: ' + p);
  const helperSha256 = {};
  for (const p of REQUIRED_NATIVE) {
    const bytes = nativeHelpers?.[p];
    requireState(Buffer.isBuffer(bytes) && bytes.length > 0, 'native helper bytes missing: ' + p);
    helperSha256[p] = sha256(bytes);
  }
  return {
    schemaVersion: 1,
    release: { ...FROZEN_RELEASE },
    registryTarball: { status: 'REGISTRY_BYTES_VERIFIED', sha256: sha256(tarballBytes),
      sha1: actualSha1, integrity: actualIntegrity, sizeBytes: tarballBytes.length },
    embeddedSourceClaim: { status: 'MATCHES_DECLARED_GIT_SHA_NOT_REPRODUCIBLE_BUILD_PROOF',
      commit: runtimeManifest.sourceCommit },
    nativeHelperPublishedBytes: { status: 'HASHED_FROM_PUBLISHED_TARBALL_NOT_EXECUTED',
      sha256: helperSha256 },
    originalWindowsInstalledRuntime: 'NOT_RUN',
    physicalHelperExecution: 'NOT_RUN',
    separatelyRebuiltSourceEquivalence: 'NOT_VERIFIED',
    hostedDeploymentVersion: 'NOT_VERIFIED',
    notes: [
      'An npm registry integrity match verifies downloaded artifact bytes, not source reproducibility.',
      'The embedded sourceCommit is the package publisher claim; independent rebuild comparison is a separate gate.',
      'Linux registry inspection cannot certify a physical Windows install or native helper execution.'
    ]
  };
}

const run = (command, args, opts = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts
});
export function inspectPublishedRelease() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mecord-wave0-npm-'));
  try {
    const spec = FROZEN_RELEASE.name + '@' + FROZEN_RELEASE.version;
    const registry = 'https://registry.npmjs.org';
    const registryDist = JSON.parse(run('npm', [
      'view', spec, 'dist', '--json', '--registry=' + registry
    ]));
    const packs = JSON.parse(run('npm', [
      'pack', spec, '--json', '--ignore-scripts', '--pack-destination', tmp,
      '--registry=' + registry
    ]));
    requireState(Array.isArray(packs) && packs.length === 1 &&
      packs[0].filename === 'mecord-connect-2.0.6.tgz', 'unexpected npm pack output');
    const archive = path.join(tmp, packs[0].filename);
    const tarballBytes = fs.readFileSync(archive);
    const tar = (member) => execFileSync('tar', ['-xOf', archive, member],
      { maxBuffer: 64 * 1024 * 1024 });
    const members = run('tar', ['-tf', archive]).trim().split(/\r?\n/);
    const packageJson = JSON.parse(tar('package/package.json').toString('utf8'));
    const runtimeManifest = JSON.parse(tar('package/runtime/runtime-manifest.json').toString('utf8'));
    const nativeHelpers = Object.fromEntries(REQUIRED_NATIVE.map(name =>
      [name, tar('package/' + name)]));
    return verifyPublishedRelease({
      registryDist, packedMetadata: packs[0], tarballBytes, packageJson,
      runtimeManifest, nativeHelpers, members
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(JSON.stringify(inspectPublishedRelease(), null, 2) + '\n');
}
