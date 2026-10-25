import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

test('C11 production release must enforce owner-signed full workboard before signing material is processed', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/windows-production-release.yml', import.meta.url), 'utf8');
  const source = workflow.indexOf('- name: Require PR-certified green main commit');
  const guard = workflow.indexOf('- name: Require signed Wave 0-4 certification and owner release approval');
  const signing = workflow.indexOf('- name: Validate release inputs and materialize signing certificate');
  const publish = workflow.indexOf('- name: Publish immutable GitHub Release assets');
  assert.ok(source > 0 && source < guard && guard < signing && signing < publish);
  const gateBody = workflow.slice(guard, workflow.indexOf('\n      - name:', guard + 10));
  assert.match(gateBody, /run: node scripts\/wave4-publication-gate\.mjs/);
  for (const key of [
    'OPERATOR_WAVE4_RELEASE_ATTESTATION_B64',
    'OPERATOR_WAVE4_RELEASE_SIGNATURE_B64',
    'OPERATOR_WAVE4_RELEASE_PUBLIC_KEY_PEM'
  ]) assert.match(gateBody, new RegExp('secrets\\.' + key));
  assert.match(workflow, /permissions:[\s\S]*?issues: read/);
  assert.doesNotMatch(gateBody, /\n\s+if:/);
});
