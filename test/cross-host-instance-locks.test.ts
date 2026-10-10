import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLocalAgentStateInstanceLock } from '../apps/local-agent/src/state-instance-lock.ts';
import { acquireRelayStateInstanceLock } from '../apps/relay-server/src/state-instance-lock.ts';

const ORIGINAL = 'linux-boot-id:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:ticks:1234';
const LOCAL = 'linux-boot-id:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:ticks:5678';

for (const kind of ['local-agent', 'relay-server'] as const) {
  for (const status of ['live', 'dead'] as const) {
    test('cross-host ' + kind + ' lock cannot be stolen by local ' + status + ' PID observation', async t => {
      const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-instance-boot-'));
      t.after(() => fs.rm(state, { recursive: true, force: true }));
      const filename = kind === 'local-agent' ? 'local-agent.lock' : 'relay-server.lock';
      const lockFile = path.join(state, filename);
      const remote = {
        version: kind === 'local-agent' ? 2 : 1,
        pid: 42711,
        processInstance: { pid: 42711, started: ORIGINAL },
        token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: new Date().toISOString()
      };
      await fs.writeFile(lockFile, JSON.stringify(remote));
      const options = {
        pid: 42712,
        processInstance: { pid: 42712, started: LOCAL },
        observeProcessInstance: async (pid: number) => status === 'dead'
          ? { status: 'dead' as const }
          : { status: 'live' as const, identity: { pid, started: LOCAL } }
      };
      await assert.rejects(
        kind === 'local-agent'
          ? acquireLocalAgentStateInstanceLock(state, options)
          : acquireRelayStateInstanceLock(state, options),
        (error: any) => error?.code === (kind === 'local-agent' ? 'LOCAL_AGENT_ALREADY_RUNNING' : 'RELAY_ALREADY_RUNNING')
      );
      assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), remote);
    });
  }
}

for (const kind of ['local-agent', 'relay-server'] as const) {
  for (const caseName of ['string-pid', 'number-token', 'string-version', 'number-timestamp'] as const) {
    test(kind + ' rejects type-coerced persisted ' + caseName + ' lock owner', async t => {
      const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-lock-owner-types-'));
      t.after(() => fs.rm(state, { recursive: true, force: true }));
      const lockFile = path.join(state, kind === 'local-agent' ? 'local-agent.lock' : 'relay-server.lock');
      const malformed: Record<string, unknown> = {
        version: kind === 'local-agent' ? 2 : 1,
        pid: 42711,
        processInstance: { pid: 42711, started: ORIGINAL },
        token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: new Date().toISOString()
      };
      if (caseName === 'string-pid') malformed.pid = '42711';
      if (caseName === 'number-token') malformed.token = 12345678901234567890;
      if (caseName === 'string-version') malformed.version = String(malformed.version);
      if (caseName === 'number-timestamp') malformed.createdAt = 20261010;
      await fs.writeFile(lockFile, JSON.stringify(malformed));
      const options = { pid: 42712, processInstance: { pid: 42712, started: LOCAL } };
      await assert.rejects(
        kind === 'local-agent'
          ? acquireLocalAgentStateInstanceLock(state, options)
          : acquireRelayStateInstanceLock(state, options),
        (error: any) => error?.code === (kind === 'local-agent' ? 'LOCAL_AGENT_STATE_LOCK_INVALID' : 'RELAY_STATE_LOCK_INVALID')
      );
      assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), malformed);
    });
  }
}
