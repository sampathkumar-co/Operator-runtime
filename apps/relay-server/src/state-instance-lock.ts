import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from '../../../src/core/errors.ts';
import {
  currentProcessInstance,
  localPidObservationAdmissible,
  observeProcessInstance,
  observerFromLegacyInspector,
  processInstanceDefinitelyStale,
  sameProcessInstance,
  type ProcessInstanceIdentity,
  type ProcessInstanceInspector,
  type ProcessInstanceObserver,
  validProcessInstance
} from '../../../src/core/process-instance.ts';

type LockRecord = {
  version: 1;
  pid: number;
  processInstance: ProcessInstanceIdentity;
  token: string;
  createdAt: string;
};

export type RelayStateInstanceLock = { path: string; release(): Promise<void> };

export async function acquireRelayStateInstanceLock(
  stateDir: string,
  options: {
    pid?: number;
    token?: string;
    clock?: () => Date;
    processInstance?: ProcessInstanceIdentity;
    observeProcessInstance?: ProcessInstanceObserver;
    /** @deprecated Legacy identity-only seam. A null result is UNKNOWN, never confirmed dead. */
    inspectProcessInstance?: ProcessInstanceInspector;
  } = {}
): Promise<RelayStateInstanceLock> {
  const root = path.resolve(stateDir);
  const lockPath = path.join(root, 'relay-server.lock');
  const pid = options.pid ?? process.pid;
  const token = options.token ?? crypto.randomUUID();
  const clock = options.clock ?? (() => new Date());
  const observer = options.observeProcessInstance
    ?? (options.inspectProcessInstance ? observerFromLegacyInspector(options.inspectProcessInstance) : observeProcessInstance);
  const identity = options.processInstance ?? (pid === process.pid
    ? await currentProcessInstance()
    : { pid, started: `injected:${pid}` });
  if (identity.pid !== pid) throw invalid('Relay process identity PID does not match the requested lock PID.');
  await fs.mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      const record: LockRecord = { version: 1, pid, processInstance: identity, token, createdAt: clock().toISOString() };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path: lockPath,
        async release() {
          if (released) return;
          released = true;
          let current: LockRecord | null = null;
          try { current = await readLockRecord(lockPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
          }
          if (current.pid === pid && current.token === token && sameProcessInstance(identity, current.processInstance)) {
            await fs.rm(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readLockRecord(lockPath).catch((readError) => {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw readError;
      });
      if (!existing) continue;
      // Another host's PID may be absent or reused locally. A Linux boot
      // mismatch cannot authorize stealing its persistent instance lock.
      const stale = localPidObservationAdmissible(existing.processInstance, identity)
        && processInstanceDefinitelyStale(existing.processInstance, await observer(existing.pid));
      if (!stale) {
        throw new OperatorError(
          'RELAY_ALREADY_RUNNING',
          `Another Mecord relay may still be using this state directory (pid ${existing.pid}). Ownership is retained unless process death or identity replacement is positively proven.`,
          { details: { pid: existing.pid, stateDir: root } }
        );
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new OperatorError('RELAY_STATE_LOCK_FAILED', 'Unable to acquire the Mecord relay state lock safely.');
}

async function readLockRecord(lockPath: string): Promise<LockRecord> {
  const stat = await fs.stat(lockPath);
  if (!stat.isFile() || stat.size < 2 || stat.size > 4096) throw invalid('Existing relay state lock is invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
  catch { throw invalid('Existing relay state lock is unreadable.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('Existing relay state lock is invalid.');
  const raw = parsed as Record<string, unknown>;
  const pid = Number(raw.pid);
  const token = String(raw.token ?? '');
  const createdAt = String(raw.createdAt ?? '');
  const processInstance = validProcessInstance(raw.processInstance);
  if (raw.version !== 1 || !Number.isSafeInteger(pid) || pid < 1 || token.length < 16 || token.length > 256
    || !Number.isFinite(Date.parse(createdAt)) || !processInstance || processInstance.pid !== pid) {
    throw invalid('Existing relay state lock is invalid.');
  }
  return { version: 1, pid, processInstance, token, createdAt };
}

function invalid(message: string): OperatorError {
  return new OperatorError('RELAY_STATE_LOCK_INVALID', message);
}
