import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import {
  currentProcessInstance, observeProcessInstance, processInstanceDefinitelyStale,
  validProcessInstance, type ProcessInstanceIdentity
} from './process-instance.ts';

const ATTEMPTS = 100;
const WAIT_MS = 25;

interface LockOwner {
  token: string;
  processInstance: ProcessInstanceIdentity;
}

function locked(): OperatorError {
  return new OperatorError('DURABLE_STATE_LOCK_BUSY', 'Durable state is owned by another active or unknown process; refusing an unsafe concurrent update.', { retryable: true });
}

async function lockOwner(file: string): Promise<LockOwner | null> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048 || stat.size < 2) return null;
  const data = await fs.readFile(file, 'utf8');
  const candidate: unknown = JSON.parse(data);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  const identity = validProcessInstance(value.processInstance);
  if (!identity || typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)) return null;
  return { token: value.token, processInstance: identity };
}

/** Exact-owner interprocess exclusive lock for a durable JSON read/modify/write transaction.
 * An unknown or malformed lock is never treated as stale. It must be reconciled.
 */
export async function withDurableStateLock<T>(stateFile: string, callback: () => Promise<T>): Promise<T> {
  const file = path.resolve(stateFile) + '.lock';
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw locked();
  const identity = await currentProcessInstance();
  const owner: LockOwner = { token: crypto.randomUUID(), processInstance: identity };
  let owned = false;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close();
        try { await fs.rm(file); } catch { /* caller fails; leave unknown lock quarantined */ }
        throw error;
      }
      await handle.close();
      owned = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // Windows can return EPERM while another owner is atomically creating
        // or removing a lock. Retry only when a real lock file exists.
        if (code !== 'EPERM' && code !== 'EACCES') throw error;
        try { await fs.lstat(file); } catch { throw error; }
      }
    }
    try {
      const previous = await lockOwner(file);
      if (previous) {
        const observation = await observeProcessInstance(previous.processInstance.pid);
        if (processInstanceDefinitelyStale(previous.processInstance, observation)) {
          // Verify this is still the same observed token before removing a dead-owner lock.
          const again = await lockOwner(file);
          if (again?.token === previous.token) {
            await fs.rm(file);
            continue;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Corrupt lock or uncertain process identity: refuse to steal it.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS));
  }
  if (!owned) throw locked();
  try {
    return await callback();
  } finally {
    let current: LockOwner | null;
    try { current = await lockOwner(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('DURABLE_STATE_LOCK_LOST', 'Durable state lock vanished during the transaction.');
      throw error;
    }
    if (!current || current.token !== owner.token) {
      throw new OperatorError('DURABLE_STATE_LOCK_LOST', 'Durable state lock ownership changed during the transaction.');
    }
    await fs.rm(file);
  }
}
