import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_TRUTH } from '../src/core/release-truth.ts';
import { validateReleaseTruthEvidence } from '../scripts/verify-release-truth.ts';

function fixture() {
  return {
    runtimeManifest: { name: 'mecord-connect', version: '2.0.4' },
    bootstrapManifest: { name: 'operator-runtime-cli', version: '1.0.0' },
    releaseState: {
      schemaVersion: 1,
      statusDate: '2026-09-28',
      production: {
        sourceCommit: 'b73d699f3cdca4d6e372942f626012fb4909068b',
        publicMcp: 'https://operator.splcart.in/mcp',
        developerMcp: 'https://developer.operator.splcart.in/mcp'
      },
      versions: {
        publicProduct: '1.0.0',
        runtimePackage: '2.0.1',
        runtimeTag: 'latest'
      }
    },
    headCommit: 'ed5948ff3f386f91ccd27674ed278a8ba5c624e6'
  };
}

test('release truth preserves the distinction between source package state and deployed production state', () => {
  const evidence = validateReleaseTruthEvidence(fixture());
  assert.equal(evidence.source.runtimePackageVersion, '2.0.4');
  assert.equal(evidence.production.runtimePackageVersion, '2.0.1');
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
