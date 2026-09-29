import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from '../../../src/core/errors.ts';

type LockRecord = {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
};

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
    isProcessAlive?: (pid: number) => boolean;
  } = {}
): Promise<LocalAgentStateInstanceLock> {
  const root = path.resolve(stateDir);
  const lockPath = path.join(root, 'local-agent.lock');
  const pid = options.pid ?? process.pid;
  const token = options.token ?? crypto.randomUUID();
  const clock = options.clock ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  await fs.mkdir(root, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      const record: LockRecord = { version: 1, pid, token, createdAt: clock().toISOString() };
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
          if (current?.pid === pid && current.token === token) {
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
      if (isProcessAlive(existing.pid)) {
        throw new OperatorError(
          'LOCAL_AGENT_ALREADY_RUNNING',
          `Another Mecord local agent is already using this state directory (pid ${existing.pid}). Stop the other runtime before starting a new one.`,
          { details: { pid: existing.pid, stateDir: root } }
        );
      }
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new OperatorError('LOCAL_AGENT_STATE_LOCK_FAILED', 'Unable to acquire the Mecord local-agent state lock safely.');
}

async function readLockRecord(lockPath: string): Promise<LockRecord> {
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
  if (raw.version !== 1 || !Number.isSafeInteger(pid) || pid < 1 || token.length < 16 || token.length > 256 || !Number.isFinite(Date.parse(createdAt))) {
    throw new OperatorError('LOCAL_AGENT_STATE_LOCK_INVALID', 'Existing Mecord local-agent state lock is invalid.');
  }
  return { version: 1, pid, token, createdAt };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return false;
  }
}
