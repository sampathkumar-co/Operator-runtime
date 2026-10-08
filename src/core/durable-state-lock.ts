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

const localFileTurns = new Map<string, Promise<void>>();
const MAX_LOCAL_WAIT_MS = 12_000;

async function withLocalFileTurn<T>(file: string, work: () => Promise<T>): Promise<T> {
  // Independent objects in the same Node process must queue *before* spinning
  // on the OS lock. The OS lock remains the final cross-process authority.
  const previous = localFileTurns.get(file);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  localFileTurns.set(file, turn);
  let previousSettled = previous === undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    release();
    if (localFileTurns.get(file) === turn) localFileTurns.delete(file);
  };
  try {
    if (previous) {
      await Promise.race([
        previous.then(() => { previousSettled = true; }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(locked()), MAX_LOCAL_WAIT_MS);
        })
      ]);
    }
    return await work();
  } finally {
    if (timeout) clearTimeout(timeout);
    // A timed-out waiter must NOT release its successor ahead of an active
    // predecessor. Defer turn release until that predecessor actually finishes.
    if (previous && !previousSettled) void previous.then(finish, finish);
    else finish();
  }
}

/** Exact-owner interprocess exclusive lock for a durable JSON read/modify/write transaction.
 * An unknown or malformed lock is never treated as stale. It must be reconciled.
 */
export async function withDurableStateLock<T>(
  stateFile: string, callback: () => Promise<T>, options: { lockFile?: string } = {}
): Promise<T> {
  // The resource-lease coordinator retains its existing legacy lock pathname,
  // preventing two running versions from silently using distinct lock domains.
  const statePath = path.resolve(stateFile);
  const file = options.lockFile === undefined ? statePath + '.lock' : path.resolve(options.lockFile);
  if (path.dirname(file) !== path.dirname(statePath) || file === statePath) {
    throw locked();
  }
  return await withLocalFileTurn(file, async () => {
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
        // Windows sometimes reports EPERM/EACCES while a competing lock
        // disappears before inspection. Treat that as bounded contention,
        // never as permission to enter the critical section.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
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
  });
}
