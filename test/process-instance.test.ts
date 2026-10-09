import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  inspectProcessInstance,
  processInstanceDefinitelyStale,
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
  if (process.platform === 'linux') assert.match(identity.started,
    /^linux-boot-id:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:ticks:\d+$/);
});

test('Windows FILETIME identity remains compatible with legacy ISO lock records', () => {
  const legacy: ProcessInstanceIdentity = { pid: 42, started: '2026-10-04T04:44:00.4739890Z' };
  const compatible: ProcessInstanceIdentity = { pid: 42, started: 'windows-filetime:134355626404730000' };
  const different: ProcessInstanceIdentity = { pid: 42, started: 'windows-filetime:134355626404740000' };
  assert.equal(sameProcessInstance(legacy, compatible), true);
  assert.equal(sameProcessInstance(legacy, different), false);
  assert.equal(sameProcessInstance(legacy, { ...compatible, pid: 43 }), false);
});

test('Linux process identity separates boot UUID even with the same PID and start ticks', () => {
  const first: ProcessInstanceIdentity = {
    pid: 455, started: 'linux-boot-id:12345678-1234-1234-1234-123456789abc:ticks:8000'
  };
  const otherBoot: ProcessInstanceIdentity = {
    pid: 455, started: 'linux-boot-id:abcdef01-1234-1234-1234-123456789abc:ticks:8000'
  };
  assert.equal(sameProcessInstance(first, first), true);
  assert.equal(sameProcessInstance(first, otherBoot), false);
  assert.equal(processInstanceDefinitelyStale(first, { status: 'live', identity: otherBoot }), true);
});

test('Linux mixed-version lease migration is not proof of process death', () => {
  const legacy: ProcessInstanceIdentity = { pid: 455, started: 'linux-boot-ticks:8000' };
  const bootBound: ProcessInstanceIdentity = {
    pid: 455, started: 'linux-boot-id:12345678-1234-1234-1234-123456789abc:ticks:8000'
  };
  // Fail closed even if a v2 observer sees a process with the old PID, since
  // legacy tick-only IDs cannot establish which machine owns the old lease.
  assert.equal(sameProcessInstance(legacy, bootBound), false);
  assert.equal(processInstanceDefinitelyStale(legacy, { status: 'live', identity: bootBound }), false);
  assert.equal(processInstanceDefinitelyStale(bootBound, { status: 'live', identity: legacy }), false);
  assert.equal(processInstanceDefinitelyStale(legacy, { status: 'dead' }), true);
  assert.equal(processInstanceDefinitelyStale(bootBound, { status: 'live', identity: {
    pid: bootBound.pid + 1, started: bootBound.started
  } }), true);
});
