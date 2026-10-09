import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { PostgresControlPlaneStore } from '../../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../../src/core/remote-authority-fence.ts';

if (process.env.OPERATOR_REAL_PG_TEST !== '1') {
  test('cross-process PostgreSQL authority crash matrix requires ephemeral test database', { skip: true }, () => {});
} else {
  if (process.env.PGDATABASE !== 'operator_test') throw new Error('Refusing cross-process test outside operator_test');
  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'operator_test', password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE, max: 8
  });
  const store = new PostgresControlPlaneStore(pool);
  const fences = (clock) => new RemoteAuthorityFenceStore(store, {
    authorize: async () => {},
    authorizeMutation: async (_subject, mutation) => {
      if (mutation.namespace !== 'provider-effects') throw new Error('scope denied');
    },
    ...(clock ? { clock } : {})
  });
  test.before(async () => { await store.initialize(); });
  test.beforeEach(async () => { await pool.query('TRUNCATE TABLE mecord_control_plane'); });
  test.after(async () => { await pool.end(); });

  const workerPath = new URL('./fixtures/remote-authority-worker.mjs', import.meta.url);
  const subject = () => ({
    accountId: crypto.randomUUID(), deviceId: crypto.randomUUID(), authorityGeneration: 1
  });
  async function startIndependentWorker(t, owner) {
    const child = spawn(process.execPath, ['--experimental-strip-types',
      workerPath.pathname, JSON.stringify(owner.subject), owner.name], {
      stdio: ['pipe', 'pipe', 'pipe'], env: process.env
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stdout = '', stderr = '', resolveReady, rejectReady, resolveResult, rejectResult;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const finished = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      rejectReady(new Error('PostgreSQL child did not acquire: ' + stderr));
      rejectResult(new Error('PostgreSQL child did not finish: ' + stderr));
      child.kill('SIGKILL');
    }, 25_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const end = stdout.indexOf('\n'), line = stdout.slice(0,end).trim();
        stdout = stdout.slice(end+1);
        if (line.startsWith('READY:')) resolveReady(JSON.parse(line.slice(6)));
        if (line.startsWith('RESULT:')) { clearTimeout(timeout); resolveResult(line.slice(7)); }
      }
    });
    child.once('error', error => { clearTimeout(timeout); rejectReady(error); rejectResult(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 && signal !== 'SIGKILL') {
        const error = new Error('Worker unexpectedly failed: '+code+'/'+signal+' '+stderr);
        rejectReady(error); rejectResult(error);
      }
    });
    return { child, lease: await ready, finished };
  }

  test('independent process commits are denied after a separate PostgreSQL owner revokes the lease', async t => {
    const source = subject();
    const remote = await startIndependentWorker(t, { subject: source, name: 'remote-worker-A' });
    assert.equal((await fences().assertCurrent(remote.lease)).ownerId, 'remote-worker-A');
    const barrier = await fences().revoke(source);
    assert.ok(barrier.generation > remote.lease.generation);
    remote.child.stdin.write('COMMIT\n');
    assert.equal(await remote.finished, 'REJECTED:REMOTE_AUTHORITY_FENCE_LOST');
    assert.equal(await store.get('provider-effects','remote-commit'), null);
  });

  test('SIGKILL of process owner plus expiry permits only a new generation, never reuses its old token', async t => {
    const source = subject();
    const remote = await startIndependentWorker(t, { subject: source, name: 'crash-owner' });
    const exited = once(remote.child, 'exit');
    assert.equal(remote.child.kill('SIGKILL'), true);
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    // Simulate time after the exact durable TTL, without a long wall-clock
    // delay or blind replay of the killed worker's proposed effect.
    const nextClock = () => new Date(Date.parse(remote.lease.expiresAt) + 1000);
    const replacement = await fences(nextClock).acquire(source, 'replacement-process', 5_000);
    assert.ok(replacement.generation > remote.lease.generation);
    await assert.rejects(fences(nextClock).assertCurrent(remote.lease),
      e => e?.code === 'REMOTE_AUTHORITY_FENCE_LOST');
    assert.equal((await fences(nextClock).assertCurrent(replacement)).ownerId, 'replacement-process');
    assert.equal(await store.get('provider-effects','remote-commit'), null);
  });
}
