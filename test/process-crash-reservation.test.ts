import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DeviceIdentityStore } from '../src/core/device-identity.ts';
import { DevicePoolScheduler, devicePoolAllocationRequestDigest } from '../src/core/device-pool.ts';
import { DeviceRegistryStore } from '../src/core/device-registry.ts';
import { DeviceRoutingStore } from '../src/core/device-routing.ts';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';

const fixture = fileURLToPath(new URL('./fixtures/reservation-crash-worker.mjs', import.meta.url));

async function killedAfterTransition(args: string[], stage: string): Promise<void> {
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture, ...args, stage], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let errorOutput = '';
  let entered = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput += String(chunk); });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Crash fixture timed out: ' + errorOutput)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (!entered && output.includes('CRASH_POINT_REACHED:' + stage)) {
        entered = true;
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code, signal) => {
      if (!entered) {
        clearTimeout(timeout);
        reject(new Error('Fixture exited before durable boundary: ' + code + '/' + signal + ': ' + errorOutput));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  try {
    await ready;
    const terminated = once(child, 'exit');
    assert.equal(child.kill('SIGKILL'), true);
    const [, signal] = await terminated;
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('real SIGKILL at reservation journal boundaries preserves exact identity and no duplicate allocation', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX SIGKILL semantics are required for this fault injection; Windows is covered by platform and regular recovery tests');
    return;
  }
  for (const stage of ['prepared', 'reserved', 'confirmed']) {
    await t.test(stage, async (caseContext) => {
      const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-sigkill-reservation-'));
      const identityDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-sigkill-identity-'));
      caseContext.after(() => Promise.all([state, identityDir].map((dir) => fs.rm(dir, { recursive: true, force: true }))));
      const registry = new DeviceRegistryStore(state);
      const routing = new DeviceRoutingStore(state, registry);
      const peer = await new DeviceIdentityStore(identityDir, { platform: 'linux' }).loadOrCreate('crash-device');
      await registry.registerVerifiedPeer(peer);
      const sessionId = crypto.randomUUID();
      const reservationId = crypto.randomUUID();
      const intentId = 'crash-injection:' + crypto.randomUUID();

      await killedAfterTransition([state, peer.deviceId, sessionId, reservationId, intentId], stage);

      // Fresh store objects after OS process death, no callbacks on the victim.
      const restartedJournal = new DurableCompensationJournal(state);
      const pending = await restartedJournal.pending('digital-operation');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.id, intentId);
      assert.equal(pending[0]?.targetId, reservationId);
      assert.equal(Boolean(pending[0]?.confirmedAt), stage === 'confirmed');
      const request = { workloadKey: 'crash-injection-workload' };
      const exactRequestDigest = devicePoolAllocationRequestDigest(request);
      assert.equal(pending[0]?.allocationRequestDigest, exactRequestDigest);
      // A process death cannot upgrade an unacknowledged journal into
      // cancellation authority by itself. Trusted immutable scheduler proof
      // is the only allowed lost-ACK reconciliation input.

      const restartedScheduler = new DevicePoolScheduler(state, new DeviceRegistryStore(state), new DeviceRoutingStore(state, new DeviceRegistryStore(state)));
      const active = await restartedScheduler.list({ activeOnly: true });
      assert.equal(active.length, stage === 'prepared' ? 0 : 1);
      if (stage === 'prepared') {
        assert.equal(await restartedScheduler.inspectPrepared(reservationId, exactRequestDigest), null);
      } else {
        const proof = await restartedScheduler.inspectPrepared(reservationId, exactRequestDigest);
        assert.equal(proof?.id, reservationId);
        assert.equal(proof?.workloadKey, request.workloadKey);
        await assert.rejects(restartedScheduler.inspectPrepared(reservationId,
          devicePoolAllocationRequestDigest({ workloadKey: 'unrelated-workload' })),
          (error: any) => error?.code === 'DEVICE_POOL_ALLOCATION_PROOF_MISMATCH');
      }

      if (stage !== 'prepared') {
        assert.equal(active[0]?.id, reservationId);
        // Reusing the same ID after a lost response cannot reserve again.
        await assert.rejects(
          restartedScheduler.reserve({ workloadKey: 'crash-injection-workload' }, [{
            deviceId: peer.deviceId, sessionId, capabilities: ['file.read'],
            observedAt: new Date().toISOString(), cpuSlots: 2, memoryMb: 4096,
            gpu: false, tags: [], activeJobs: 0, maxConcurrentJobs: 1
          }], { reservationId }),
          (error: any) => error?.code === 'DEVICE_POOL_RESERVATION_ID_CONFLICT'
        );
        assert.equal((await restartedScheduler.list({ activeOnly: true })).length, 1);
      }
      // Unknown prepared/reserved handoffs remain journaled; this test never
      // treats process death or an unacknowledged reservation as release proof.
      assert.equal((await restartedJournal.pending('digital-operation')).length, 1);
      if (stage !== 'prepared') {
        const exactProof = await restartedScheduler.inspectPrepared(reservationId, exactRequestDigest);
        assert.ok(exactProof);
        const terminal = await restartedScheduler.release(exactProof!.id);
        assert.equal(terminal.id, reservationId);
        assert.equal(terminal.state, 'RELEASED');
        assert.equal((await restartedScheduler.list({ activeOnly: true })).length, 0);
      }
      // Only a higher-level recovery transaction can retire the journal; a
      // scheduler release alone must never silently erase the intent.
      assert.equal((await restartedJournal.pending('digital-operation')).length, 1);

    });
  }
});
