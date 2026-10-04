import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  inspectProcessInstance,
  sameProcessInstance,
  type ProcessInstanceIdentity
} from '../src/core/process-instance.ts';

test('current process identity is inspectable without PID-only authority', async () => {
  if (process.platform === 'win32') {
    const helper = path.resolve('native/windows-path-lease/target/release/operator-windows-path-lease.exe');
    assert.ok(fs.existsSync(helper), 'Windows process identity test requires the built native helper.');
    process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH = helper;
  }
  const identity = await inspectProcessInstance(process.pid);
  assert.ok(identity);
  assert.equal(identity.pid, process.pid);
  if (process.platform === 'win32') assert.match(identity.started, /^windows-filetime:\d{15,20}$/);
});

test('Windows FILETIME identity remains compatible with legacy ISO lock records', () => {
  const legacy: ProcessInstanceIdentity = { pid: 42, started: '2026-10-04T04:44:00.4739890Z' };
  const compatible: ProcessInstanceIdentity = { pid: 42, started: 'windows-filetime:134355626404730000' };
  const different: ProcessInstanceIdentity = { pid: 42, started: 'windows-filetime:134355626404740000' };
  assert.equal(sameProcessInstance(legacy, compatible), true);
  assert.equal(sameProcessInstance(legacy, different), false);
  assert.equal(sameProcessInstance(legacy, { ...compatible, pid: 43 }), false);
});
