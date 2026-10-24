import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STABLE_RELEASE_COMMIT, SOURCE_FILES, extractProviderNames, extractPublicTools,
  buildSourceProvenance
} from '../scripts/wave0-source-manifest.mjs';

const candidateCommit = 'f'.repeat(40);
const publicTools = `export const PUBLIC_PLUGIN_TOOL_NAMES = Object.freeze([
  'computer.inspect', 'project.inspect', 'project.commands',
  'file.list', 'file.read', 'file.create', 'file.replace',
  'git.status', 'git.diff'
].sort());`;
const runtimeFactory = Array.from({ length: 12 }, (_, i) => `.register(new Test${i}Provider())`).join('\n');
function manifestInput() {
  const files = Object.fromEntries(SOURCE_FILES.map(name => [name, Buffer.from('fixture ' + name)]));
  files['packages/mecord-connect/package.json'] = Buffer.from(JSON.stringify({ name: 'mecord-connect', version: '2.0.6' }));
  files['src/core/public-plugin-surface.ts'] = Buffer.from(publicTools);
  files['apps/local-agent/src/runtime-factory.ts'] = Buffer.from(runtimeFactory);
  return { releaseCommit: STABLE_RELEASE_COMMIT, candidateCommit, clean: true,
    releaseFiles: files, candidateFiles: { ...files }, nodeVersion: 'v22.23.2', platform: 'linux' };
}

test('source manifest binds frozen release and candidate files without claiming npm or physical evidence', () => {
  const m = buildSourceProvenance(manifestInput());
  assert.equal(m.release.version, '2.0.6');
  assert.equal(m.candidate.commit, candidateCommit);
  assert.equal(m.source.publicTools.length, 9);
  assert.equal(m.source.providerRegistrations.length, 12);
  assert.equal(Object.keys(m.source.sha256).length, SOURCE_FILES.length);
  assert.equal(m.release.npmRegistryTarball.status, 'NOT_VERIFIED');
  assert.equal(m.release.compiledNativeHelpers.status, 'NOT_VERIFIED');
  assert.equal(m.evaluations.laneC, 'NOT_RUN');
  assert.equal(m.environment.physicalWindows, 'NOT_RUN');
});

test('dirty or non-immutable source identity fails closed', () => {
  assert.throws(() => buildSourceProvenance({ ...manifestInput(), clean: false }), /dirty checkout/);
  assert.throws(() => buildSourceProvenance({ ...manifestInput(), candidateCommit: 'main' }), /full commit SHA/);
});

test('replaced or missing pinned file is rejected rather than silently omitted', () => {
  const fixture = manifestInput();
  delete fixture.candidateFiles['src/core/runtime.ts'];
  assert.throws(() => buildSourceProvenance(fixture), /Missing pinned file/);
});

test('public compatibility changes require explicit review instead of a false nine-tool certification', () => {
  const fixture = manifestInput();
  fixture.candidateFiles['src/core/public-plugin-surface.ts'] = Buffer.from(publicTools.replace("'git.diff'", "'git.reset'"));
  assert.throws(() => buildSourceProvenance(fixture), /Public nine-tool surface differs/);
});

test('release package mismatch cannot be described as the 2.0.6 baseline', () => {
  const fixture = manifestInput();
  fixture.releaseFiles['packages/mecord-connect/package.json'] =
    Buffer.from(JSON.stringify({ name: 'mecord-connect', version: '2.0.5' }));
  assert.throws(() => buildSourceProvenance(fixture), /does not contain the declared/);
});

test('provider registration inventory comes from source but does not imply certification', () => {
  assert.deepEqual(extractProviderNames(runtimeFactory).length, 12);
  assert.deepEqual(extractPublicTools(publicTools).length, 9);
  assert.throws(() => extractProviderNames('register(new OneProvider())'), /incomplete/);
});
