import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('C10 dashboard distinguishes relay source drift from package mismatch without credentials', async () => {
  const js = await fs.readFile(path.resolve('apps/control-center/src/runtime-status.js'), 'utf8');
  assert.match(js, /Relay server source/);
  assert.match(js, /Relay source compatibility/);
  assert.match(js, /status\.relay\.sourceCompatibility==="MISMATCH"/);
  assert.match(js, /Relay server source unverified/);
  assert.doesNotMatch(js, /sessionStorage|localStorage|access_token|refresh_token/);
});
