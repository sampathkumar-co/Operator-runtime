import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('registration code generator produces readable random code and server-only hash', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mecord-code-'));
  const run = spawnSync(process.execPath, ['deploy/auth-portal/generate-registration-code.mjs', out], {
    cwd: path.resolve('.'),
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  const code = fs.readFileSync(path.join(out, 'registration-code.txt'), 'utf8').trim();
  const env = fs.readFileSync(path.join(out, 'portal.env'), 'utf8').trim();
  assert.match(code, /^MCRD-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const digest = crypto.createHash('sha256').update(code).digest('hex');
  assert.equal(env, 'PORTAL_INVITE_SHA256=' + digest);
  assert.ok(!env.includes(code));
});
