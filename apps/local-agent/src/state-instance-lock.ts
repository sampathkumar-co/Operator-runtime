import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from '../../../src/core/errors.ts';
import {
  currentProcessInstance,
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
  version: 2;
  pid: number;
  processInstance: ProcessInstanceIdentity;
  token: string;
  createdAt: string;
};

type LegacyLockRecord = Omit<LockRecord, 'version' | 'processInstance'> & { version: 1 };

export type LocalAgentStateInstanceLock = {
  path: string;
  release(): Promise<void>;
};

export async function acquireLocalAgentStateInstanceLock(
  stateDir: string,
  options: {
    pid?: number;
    token?: string;
    clock?: () => Date;
    processInstance?: ProcessInstanceIdentity;
    observeProcessInstance?: ProcessInstanceObserver;
    /** @deprecated Legacy identity-only seam. A null result is UNKNOWN, never confirmed dead. */
    inspectProcessInstance?: ProcessInstanceInspector;
    /** @deprecated Test-only PID seam. false is explicit confirmed-dead input from the test. */
    isProcessAlive?: (pid: number) => boolean;
  } = {}
): Promise<LocalAgentStateInstanceLock> {
  const root = path.resolve(stateDir);
  const lockPath = path.join(root, 'local-agent.lock');
  const pid = options.pid ?? process.pid;
  const token = options.token ?? crypto.randomUUID();
  const clock = options.clock ?? (() => new Date());
  const observer = options.observeProcessInstance
    ?? (options.inspectProcessInstance ? observerFromLegacyInspector(options.inspectProcessInstance) : observeProcessInstance);
  const identity = options.processInstance ?? (pid === process.pid
    ? await currentProcessInstance()
    : { pid, started: `injected:${pid}` });
  if (identity.pid !== pid) throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Local process identity PID does not match the requested lock PID.');
  await fs.mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      const record: LockRecord = { version: 2, pid, processInstance: identity, token, createdAt: clock().toISOString() };
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
          let current: LockRecord | LegacyLockRecord | null = null;
          try { current = await readLockRecord(lockPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
          }
          if (current?.pid === pid && current.token === token && (current.version === 1 || sameProcessInstance(identity, current.processInstance))) {
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
      const stale = options.isProcessAlive
        ? !options.isProcessAlive(existing.pid)
        : processInstanceDefinitelyStale(
            existing.version === 2 ? existing.processInstance : undefined,
            await observer(existing.pid)
          );
      if (!stale) {
        throw new OperatorError(
          'LOCAL_AGENT_ALREADY_RUNNING',
          `Another Mecord local agent may still be using this state directory (pid ${existing.pid}). Ownership is retained unless process death or identity replacement is positively proven.`,
          { details: { pid: existing.pid, stateDir: root } }
        );
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new OperatorError('LOCAL_AGENT_STATE_LOCK_FAILED', 'Unable to acquire the Mecord local-agent state lock safely.');
}

async function readLockRecord(lockPath: string): Promise<LockRecord | LegacyLockRecord> {
  const stat = await fs.stat(lockPath);
  if (!stat.isFile() || stat.size < 2 || stat.size > 4096) {
    throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock is invalid.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
  catch { throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock is unreadable.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock is invalid.');
  }
  const raw = parsed as Record<string, unknown>;
  const pid = Number(raw.pid);
  const token = String(raw.token ?? '');
  const createdAt = String(raw.createdAt ?? '');
  if (![1, 2].includes(Number(raw.version)) || !Number.isSafeInteger(pid) || pid < 1 || token.length < 16 || token.length > 256 || !Number.isFinite(Date.parse(createdAt))) {
    throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock is invalid.');
  }
  if (raw.version === 1) return { version: 1, pid, token, createdAt };
  const processInstance = validProcessInstance(raw.processInstance);
  if (!processInstance || processInstance.pid !== pid) throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock process identity is invalid.');
  return { version: 2, pid, processInstance, token, createdAt };
}
