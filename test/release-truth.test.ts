import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_TRUTH } from '../src/core/release-truth.ts';
import { validateReleaseTruthEvidence } from '../scripts/verify-release-truth.ts';

function fixture() {
  return {
    runtimeManifest: { name: 'mecord-connect', version: '2.0.7' },
    bootstrapManifest: { name: 'operator-runtime-cli', version: '1.0.0' },
    releaseState: {
      schemaVersion: 1,
      statusDate: '2026-10-07',
      production: {
        sourceCommit: 'ef3bcdc2fcbc56b1b42f7a7a6f09ceabfc5a2bf2',
        publicMcp: 'https://operator.splcart.in/mcp',
        developerMcp: 'https://developer.operator.splcart.in/mcp'
      },
      versions: {
        publicProduct: '1.0.0',
        runtimePackage: '2.0.5',
        runtimeTag: 'latest'
      }
    },
    headCommit: 'ed5948ff3f386f91ccd27674ed278a8ba5c624e6'
  };
}

test('release truth records the deployed production state independently from the current documentation head', () => {
  const evidence = validateReleaseTruthEvidence(fixture());
  assert.equal(evidence.source.runtimePackageVersion, '2.0.7');
  assert.equal(evidence.production.runtimePackageVersion, '2.0.5');
  assert.equal(evidence.production.sourceCommit, RELEASE_TRUTH.production.sourceCommit);
  assert.notEqual(evidence.source.headCommit, evidence.production.sourceCommit);
});

test('release truth fails closed when a source package version drifts', () => {
  const input = fixture();
  input.runtimeManifest.version = '2.0.5';
  assert.throws(() => validateReleaseTruthEvidence(input), /source runtime package version mismatch/);
});

test('release truth fails closed when deployed production evidence drifts', () => {
  const input = fixture();
  input.releaseState.versions.runtimePackage = '2.0.4';
  assert.throws(() => validateReleaseTruthEvidence(input), /production runtime package version mismatch/);
});

test('release truth requires full immutable commit identities', () => {
  const input = fixture();
  input.releaseState.production.sourceCommit = 'deadbeef';
  assert.throws(() => validateReleaseTruthEvidence(input), /production source commit must be a full 40-character Git SHA/);
});

test('C11 release-truth identity and production URLs never use hostile object coercion', () => {
  let calls = 0;
  const forged = { toString() { calls++; return '2.0.7'; },
    valueOf() { calls++; return '2.0.7'; } };
  for (const mutate of [
    (f: any) => { f.runtimeManifest.version = ['2.0.7']; },
    (f: any) => { f.runtimeManifest.version = forged; },
    (f: any) => { f.releaseState.production.sourceCommit = ['ef3bcdc2fcbc56b1b42f7a7a6f09ceabfc5a2bf2']; },
    (f: any) => { f.releaseState.production.publicMcp = ['https://operator.splcart.in/mcp']; },
    (f: any) => { f.headCommit = ['ed5948ff3f386f91ccd27674ed278a8ba5c624e6']; },
    (f: any) => { f.releaseState.versions.publicProduct = ['1.0.0']; }
  ]) {
    const input: any = fixture();
    mutate(input);
    assert.throws(() => validateReleaseTruthEvidence(input), /must be (valid SemVer|a full 40-character Git SHA|an absolute HTTPS URL)/);
  }
  assert.equal(calls, 0, 'evidence validation must not execute caller conversion hooks');
});
