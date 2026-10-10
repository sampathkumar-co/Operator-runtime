import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountDeviceRegistry } from '../src/core/account-device-registry.ts';
import type { DeviceRegistryStore } from '../src/core/device-registry.ts';

test('killed account authority holder cannot block future disable or reuse its generation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-killed-authority-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const deviceId = crypto.randomUUID();
  const devices = { listDevices: async () => [{ deviceId, status: 'active' }] } as unknown as DeviceRegistryStore;
  const create = () => new AccountDeviceRegistry(dir, devices);
  const owner = await create().resolveOrCreateAccount({ issuer: 'test', subject: 'process-owner' });
  const membership = await create().bindDevice(owner.accountId, deviceId);
  const source = fileURLToPath(new URL('../src/core/account-device-registry.ts', import.meta.url));
  const script = [
    'import {pathToFileURL} from "node:url";',
    'const {AccountDeviceRegistry}=await import(pathToFileURL(process.argv[1]).href);',
    'const [state,accountId,deviceId,gen]=process.argv.slice(2);',
    'const devices={listDevices:async()=>[{deviceId,status:"active"}]};',
    'await new AccountDeviceRegistry(state,devices).withActiveAuthorityLease({accountId,deviceId,generation:Number(gen)},async()=>{',
    '  process.stdout.write("ACQUIRED\\n");',
    '  await new Promise(()=>{ setInterval(()=>{},1000); });',
    '});'
  ].join('\n');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, source, dir, owner.accountId, deviceId, String(membership.authorityGeneration)], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { err += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('Account authority process did not start: ' + err)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      seen += String(chunk);
      if (seen.includes('ACQUIRED')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code, signal) => { clearTimeout(timer); reject(new Error('Holder died before ready: ' + code + ' ' + signal + ' ' + err)); });
  });
  // A separate registry instance must not revoke a still-live work holder.
  const disable = create().disableAccount(owner.accountId, 'post-crash disable');
  const premature = await Promise.race([
    disable.then(() => 'disabled', () => 'failed'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100))
  ]);
  assert.equal(premature, 'pending', 'active authority must fence competing disable');
  // Register the exit observer BEFORE signalling: on heavily loaded Windows
  // runners the exit event can arrive synchronously with test scheduling.
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Killed lease owner did not exit')), 20_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
  assert.equal(child.kill('SIGKILL'), true);
  await exited;
  let disableTimer: NodeJS.Timeout | undefined;
  let disabled;
  try {
    disabled = await Promise.race([
      disable,
      new Promise<never>((_, reject) => {
        disableTimer = setTimeout(() => reject(new Error('Revocation stalled after confirmed OS process death')), 20_000);
      })
    ]);
  } finally {
    clearTimeout(disableTimer);
  }
  assert.equal(disabled.status, 'disabled');
  await assert.rejects(create().withActiveAuthorityLease(
    { accountId: owner.accountId, deviceId, generation: membership.authorityGeneration },
    async () => 'must-not-run'
  ), (error: any) => error?.code === 'ACCOUNT_AUTHORITY_REVOKED');
});
