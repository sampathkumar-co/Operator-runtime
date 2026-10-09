import pg from 'pg';
import { PostgresControlPlaneStore } from '../../../src/core/control-plane-store.ts';
import { RemoteAuthorityFenceStore } from '../../../src/core/remote-authority-fence.ts';

// Independent OS process, not a test-local Promise or mock registry.
// The parent can revoke in another PostgreSQL pool or kill this process.
const { Pool } = pg;
const [subjectText, ownerId] = process.argv.slice(2);
const subject = JSON.parse(subjectText);
const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'operator_test',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? 'operator_test',
  max: 2
});
const authority = new RemoteAuthorityFenceStore(new PostgresControlPlaneStore(pool), {
  authorize: async () => {},
  authorizeMutation: async (_subject, mutation) => {
    if (mutation.namespace !== 'provider-effects') throw new Error('provider scope denied');
  }
});
const lease = await authority.acquire(subject, ownerId, 5_000);
process.stdout.write('READY:' + JSON.stringify(lease) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.once('data', async (text) => {
  try {
    if (String(text).trim() !== 'COMMIT') throw new Error('unexpected fixture control');
    const result = await authority.commitProtected(lease, {
      namespace: 'provider-effects', key: 'remote-commit',
      expectedGeneration: null, value: { owner: ownerId, approved: true }
    });
    process.stdout.write('RESULT:COMMITTED:' + result.lease.generation + '\n');
  } catch (error) {
    process.stdout.write('RESULT:REJECTED:' + String(error?.code ?? error?.message ?? error) + '\n');
  } finally {
    await pool.end();
    process.exitCode = 0;
  }
});
// Keep stdin attached until the parent commits or delivers a true SIGKILL.
