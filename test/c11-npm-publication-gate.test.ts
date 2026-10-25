import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = async (file: string) =>
  fs.readFile(new URL('../.github/workflows/' + file, import.meta.url), 'utf8');

const ownerNames = [
  'OPERATOR_WAVE4_RELEASE_ATTESTATION_B64',
  'OPERATOR_WAVE4_RELEASE_SIGNATURE_B64',
  'OPERATOR_WAVE4_RELEASE_PUBLIC_KEY_PEM'
];

test('C11 npm runtime staging must require source-signed owner acceptance before registry mutation', async () => {
  const text = await read('npm-remote-release.yml');
  const mainJob = text.split('\n  stage-rc1:')[0];
  const source = mainJob.indexOf('- name: Require PR-certified green main commit');
  const gate = mainJob.indexOf('- name: Require signed Wave 0-4 owner acceptance before npm runtime staging');
  const stage = mainJob.indexOf('- name: Stage npm runtime with provenance');
  assert.ok(source > 0 && source < gate && gate < stage);
  const guard = mainJob.slice(gate, stage);
  assert.match(guard, /if: github\.event_name == 'push' \|\| inputs\.publication_mode == 'stage'/);
  assert.match(guard, /run: node scripts\/wave4-publication-gate\.mjs/);
  assert.match(guard, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  for (const key of ownerNames) assert.ok(guard.includes('secrets.' + key));
  assert.ok(mainJob.includes('  issues: read'));
  assert.ok(mainJob.includes('- name: Validate publishable tarball and installed-package doctor'));
  assert.ok(mainJob.includes('- name: Build canonical runtime payload'));
  assert.ok(mainJob.includes('if: github.event_name == \'push\' || inputs.publication_mode == \'stage\''));
  assert.ok(!guard.includes('if: success() || failure()'));
});
test('C11 npm bootstrap publication must require the same source-matched owner signature', async () => {
  const text = await read('npm-bootstrap-release.yml');
  const source = text.indexOf('- name: Require PR-certified green main commit');
  const guardStart = text.indexOf('- name: Require signed Wave 0-4 owner acceptance before npm bootstrap publication');
  const publish = text.indexOf('- name: Publish npm bootstrap with provenance');
  assert.ok(source > 0 && source < guardStart && guardStart < publish);
  const guard = text.slice(guardStart, publish);
  assert.match(guard, /run: node scripts\/wave4-publication-gate\.mjs/);
  for (const key of ownerNames) assert.ok(guard.includes('secrets.' + key));
  assert.ok(text.includes('  issues: read'));
  assert.ok(!/^\s*if:/m.test(guard), 'owner gate cannot be bypassed by a branch-only condition');
  assert.ok(text.includes('npm publish ./packages/operator-runtime-cli'));
});
test('C11 Windows, npm runtime and bootstrap production paths use same source-pinned gate', async () => {
  const [windows, remote, bootstrap] = await Promise.all([
    read('windows-production-release.yml'),
    read('npm-remote-release.yml'),
    read('npm-bootstrap-release.yml')
  ]);
  for (const text of [windows, remote, bootstrap]) {
    assert.match(text, /run: node scripts\/wave4-publication-gate\.mjs/);
    assert.match(text, /OPERATOR_WAVE4_RELEASE_PUBLIC_KEY_PEM/);
    assert.match(text, /  issues: read/);
  }
  const trust = JSON.parse(await fs.readFile(
    new URL('../certification/wave4-owner-key.json', import.meta.url), 'utf8'
  ));
  assert.equal(trust.status, 'NOT_ENROLLED');
  assert.equal(trust.publicKeySpkiSha256, null);
});
