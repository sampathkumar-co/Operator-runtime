import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DeveloperRuntimeOwnershipStore,
  type DeveloperRuntimeOwnershipRecord
} from '../src/core/developer-runtime-ownership.ts';
import type { ProcessInstanceIdentity } from '../src/core/process-instance.ts';

const OWNER: ProcessInstanceIdentity = { pid: 9000, started: 'test-owner:1' };
const CHILD_A: ProcessInstanceIdentity = { pid: 12001, started: 'test-child:a' };
const CHILD_B: ProcessInstanceIdentity = { pid: 12002, started: 'test-child:b' };

function uuid(seed: string): string {
  const tail = seed.padStart(12, '0').slice(-12);
  return '00000000-0000-4000-8000-' + tail;
}

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-runtime-owner-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const live = new Map<number, ProcessInstanceIdentity | null>([
    [OWNER.pid, OWNER]
  ]);
  const store = new DeveloperRuntimeOwnershipStore(dir, {
    processInstance: OWNER,
    inspectProcessInstance: async (pid) => live.get(pid) ?? null
  });
  return { dir, live, store };
}

test('running Developer Session process owns declared ports durably', async (t) => {
  const { store, live } = await fixture(t);
  const firstId = uuid('1');
  await store.beginLaunch({
    processSessionId: firstId,
    developerSessionId: 'developer-session-1',
    ports: [3000, 3001],
    now: '2026-10-06T00:00:00.000Z'
  });
  live.set(CHILD_A.pid, CHILD_A);
  const running = await store.commitLaunch(firstId, CHILD_A, '2026-10-06T00:00:01.000Z');

  assert.equal(running.phase, 'RUNNING');
  assert.deepEqual(running.ports, [3000, 3001]);

  await assert.rejects(
    () => store.beginLaunch({
      processSessionId: uuid('2'),
      developerSessionId: 'developer-session-2',
      ports: [3001],
      now: '2026-10-06T00:00:02.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RUNTIME_PORT_BUSY');
      return true;
    }
  );

});

test('PID reuse marks prior ownership EXITED and releases its ports', async (t) => {
  const { store, live } = await fixture(t);
  const firstId = uuid('10');
  await store.beginLaunch({
    processSessionId: firstId,
    developerSessionId: 'developer-session-1',
    ports: [4100],
    now: '2026-10-06T00:00:00.000Z'
  });
  live.set(CHILD_A.pid, CHILD_A);
  await store.commitLaunch(firstId, CHILD_A, '2026-10-06T00:00:01.000Z');

  live.set(CHILD_A.pid, { pid: CHILD_A.pid, started: 'test-child:reused' });
  const rows = await store.listForDeveloperSession(
    'developer-session-1',
    '2026-10-06T00:00:02.000Z'
  );
  assert.equal(rows[0]?.phase, 'EXITED');

  await assert.doesNotReject(() => store.beginLaunch({
    processSessionId: uuid('11'),
    developerSessionId: 'developer-session-2',
    ports: [4100],
    now: '2026-10-06T00:00:03.000Z'
  }));
});

test('restart recovery makes uncommitted launch intent AMBIGUOUS and keeps port blocked', async (t) => {
  const { store } = await fixture(t);
  await store.beginLaunch({
    processSessionId: uuid('20'),
    developerSessionId: 'developer-session-1',
    ports: [5200],
    now: '2026-10-06T00:00:00.000Z'
  });

  const recovered = await store.recover('2026-10-06T00:00:05.000Z');
  assert.equal(recovered[0]?.phase, 'AMBIGUOUS');

  await assert.rejects(
    () => store.beginLaunch({
      processSessionId: uuid('21'),
      developerSessionId: 'developer-session-2',
      ports: [5200],
      now: '2026-10-06T00:00:06.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RUNTIME_PORT_BUSY');
      return true;
    }
  );

  await assert.rejects(
    () => store.claimTermination(uuid('20'), '2026-10-06T00:00:07.000Z'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RUNTIME_OWNERSHIP_AMBIGUOUS');
      return true;
    }
  );
});

test('termination claim binds exact process instance and completion requires it to be gone', async (t) => {
  const { store, live } = await fixture(t);
  const id = uuid('30');
  await store.beginLaunch({
    processSessionId: id,
    developerSessionId: 'developer-session-1',
    ports: [6300],
    now: '2026-10-06T00:00:00.000Z'
  });
  live.set(CHILD_B.pid, CHILD_B);
  await store.commitLaunch(id, CHILD_B, '2026-10-06T00:00:01.000Z');

  const claimed = await store.claimTermination(id, '2026-10-06T00:00:02.000Z');
  assert.deepEqual(claimed, CHILD_B);

  await assert.rejects(
    () => store.markTerminated(id, CHILD_B, '2026-10-06T00:00:03.000Z'),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RUNTIME_TERMINATION_UNPROVEN');
      return true;
    }
  );

  live.set(CHILD_B.pid, null);
  await store.markTerminated(id, CHILD_B, '2026-10-06T00:00:04.000Z');
  const record = await store.get(id, '2026-10-06T00:00:05.000Z');
  assert.equal(record.phase, 'TERMINATED');

  await assert.doesNotReject(() => store.beginLaunch({
    processSessionId: uuid('31'),
    developerSessionId: 'developer-session-2',
    ports: [6300],
    now: '2026-10-06T00:00:06.000Z'
  }));
});

test('exit claims must match the exact owned process identity', async (t) => {
  const { store, live } = await fixture(t);
  const id = uuid('40');
  await store.beginLaunch({
    processSessionId: id,
    developerSessionId: 'developer-session-1',
    now: '2026-10-06T00:00:00.000Z'
  });
  live.set(CHILD_A.pid, CHILD_A);
  await store.commitLaunch(id, CHILD_A, '2026-10-06T00:00:01.000Z');

  await assert.rejects(
    () => store.markExited(
      id,
      { pid: CHILD_A.pid, started: 'wrong-instance' },
      '2026-10-06T00:00:02.000Z'
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_RUNTIME_PROCESS_IDENTITY_MISMATCH');
      return true;
    }
  );
});

test('persisted ownership state contains no command arguments, environment, or stream content', async (t) => {
  const { dir, store, live } = await fixture(t);
  const id = uuid('50');
  await store.beginLaunch({
    processSessionId: id,
    developerSessionId: 'developer-session-privacy',
    ports: [7400],
    now: '2026-10-06T00:00:00.000Z'
  });
  live.set(CHILD_A.pid, CHILD_A);
  await store.commitLaunch(id, CHILD_A, '2026-10-06T00:00:01.000Z');

  const raw = await fs.readFile(path.join(dir, 'developer-runtime-ownership.json'), 'utf8');
  const parsed = JSON.parse(raw) as { records: DeveloperRuntimeOwnershipRecord[] };
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(
    Object.keys(parsed.records[0]!).sort(),
    [
      'schemaVersion',
      'processSessionId',
      'developerSessionId',
      'phase',
      'processInstance',
      'ports',
      'createdAt',
      'updatedAt'
    ].sort()
  );
  for (const forbidden of ['args', 'environment', 'env', 'stdin', 'stdout', 'stderr', 'command']) {
    assert.equal(raw.toLowerCase().includes(forbidden), false);
  }
});
