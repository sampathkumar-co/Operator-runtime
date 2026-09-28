import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

export type ResourceLeaseMode = 'shared' | 'exclusive';

interface Holder {
  leaseId: string;
  ownerId: string;
  pid: number;
  mode: ResourceLeaseMode;
  acquiredAt: string;
}

interface ResourceEntry {
  key: string;
  holders: Holder[];
}

interface LeaseState {
  version: 1;
  resources: ResourceEntry[];
}

export interface ResourceLease {
  readonly id: string;
  readonly ownerId: string;
  readonly keys: string[];
  readonly mode: ResourceLeaseMode;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

const MAX_RESOURCES = 20_000;
const MAX_HOLDERS = 512;
const STATE_OPTIONS = {
  maxBytes: 16 * 1024 * 1024,
  errorCode: 'RESOURCE_LEASE_CORRUPT',
  invalidMessage: 'Resource lease state is invalid.'
} as const;

export class ResourceLeaseStore {
  #file: string;
  #lockFile: string;

  constructor(stateDir: string) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'resource-leases.json');
    this.#lockFile = path.join(root, 'resource-leases.lock');
  }

  async acquire(ownerIdInput: string, keysInput: string[], mode: ResourceLeaseMode): Promise<ResourceLease> {
    const ownerId = bounded(ownerIdInput, 256, 'ownerId');
    const keys = normalizeKeys(keysInput);
    if (keys.length === 0) return noOpLease(ownerId, mode);
    if (mode !== 'shared' && mode !== 'exclusive') throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', 'Resource lease mode is invalid.');

    const leaseId = crypto.randomUUID();
    await this.#mutate((state) => {
      reapDeadHolders(state);
      for (const key of keys) {
        const entry = state.resources.find((item) => item.key === key);
        if (!entry) continue;
        const conflicts = entry.holders.filter((holder) =>
          holder.ownerId !== ownerId && (mode === 'exclusive' || holder.mode === 'exclusive')
        );
        if (conflicts.length > 0) {
          throw new OperatorError('RESOURCE_BUSY', `Resource ${key} is owned by another active execution.`, {
            retryable: true,
            details: { key, holders: conflicts.map((holder) => ({ ownerId: holder.ownerId, mode: holder.mode })) }
          });
        }
      }
      const now = new Date().toISOString();
      for (const key of keys) {
        let entry = state.resources.find((item) => item.key === key);
        if (!entry) {
          if (state.resources.length >= MAX_RESOURCES) throw new OperatorError('RESOURCE_LEASE_LIMIT', 'Resource lease table is full.');
          entry = { key, holders: [] };
          state.resources.push(entry);
        }
        if (entry.holders.length >= MAX_HOLDERS) throw new OperatorError('RESOURCE_LEASE_LIMIT', `Resource ${key} has too many shared holders.`);
        entry.holders.push({ leaseId, ownerId, pid: process.pid, mode, acquiredAt: now });
        entry.holders.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
      }
      state.resources.sort((a, b) => a.key.localeCompare(b.key));
    });

    let released = false;
    const assertOwned = async () => {
      if (released) throw new OperatorError('RESOURCE_LEASE_LOST', 'Resource lease has already been released.');
      const state = await this.#read();
      for (const key of keys) {
        const entry = state.resources.find((item) => item.key === key);
        if (!entry?.holders.some((holder) => holder.leaseId === leaseId && holder.ownerId === ownerId && holder.pid === process.pid && holder.mode === mode)) {
          throw new OperatorError('RESOURCE_LEASE_LOST', `Resource lease ownership for ${key} was lost.`);
        }
      }
    };
    return {
      id: leaseId,
      ownerId,
      keys,
      mode,
      assertOwned,
      release: async () => {
        if (released) return;
        await this.#mutate((state) => {
          for (const entry of state.resources) {
            entry.holders = entry.holders.filter((holder) => holder.leaseId !== leaseId);
          }
          state.resources = state.resources.filter((entry) => entry.holders.length > 0);
        });
        released = true;
      }
    };
  }

  async inspect(): Promise<LeaseState> {
    const state = await this.#read();
    reapDeadHolders(state);
    return structuredClone(state);
  }

  async #read(): Promise<LeaseState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, resources: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state could not be read.');
    }
  }

  async #mutate(mutator: (state: LeaseState) => void): Promise<void> {
    const release = await this.#acquireCoordinatorLock();
    try {
      const state = await this.#read();
      mutator(state);
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STATE_OPTIONS);
    } finally {
      await release();
    }
  }

  async #acquireCoordinatorLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.#lockFile), { recursive: true, mode: 0o700 });
    const owner = { id: crypto.randomUUID(), pid: process.pid };
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const handle = await fs.open(this.#lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
        await handle.close();
        return async () => {
          try {
            const current = JSON.parse(await fs.readFile(this.#lockFile, 'utf8')) as { id?: unknown };
            if (current.id !== owner.id) throw new OperatorError('RESOURCE_LEASE_LOCK_LOST', 'Resource lease coordinator lock ownership changed.');
            await fs.rm(this.#lockFile);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('RESOURCE_LEASE_LOCK_LOST', 'Resource lease coordinator lock disappeared.');
            throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      try {
        const current = JSON.parse(await fs.readFile(this.#lockFile, 'utf8')) as { pid?: unknown };
        const pid = Number(current.pid);
        if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) {
          await fs.rm(this.#lockFile, { force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new OperatorError('RESOURCE_LEASE_LOCK_BUSY', 'Resource lease coordinator is busy.', { retryable: true });
  }
}

function noOpLease(ownerId: string, mode: ResourceLeaseMode): ResourceLease {
  return {
    id: crypto.randomUUID(),
    ownerId,
    keys: [],
    mode,
    async assertOwned() {},
    async release() {}
  };
}

function normalizeKeys(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 5000) throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', 'Resource key list is invalid.');
  const keys = [...new Set(input.map((value, index) => bounded(value, 1024, `keys[${index}]`)))].sort();
  if (keys.some((key) => key.includes('\0') || key.includes('..'))) throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', 'Resource key is invalid.');
  return keys;
}

function validateState(input: unknown): LeaseState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state must be an object.');
  const state = input as LeaseState;
  if (state.version !== 1 || !Array.isArray(state.resources) || state.resources.length > MAX_RESOURCES) {
    throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state shape is invalid.');
  }
  const keys = new Set<string>();
  for (const entry of state.resources) {
    const key = bounded(entry.key, 1024, 'resource key');
    if (keys.has(key)) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state contains duplicate resource keys.');
    keys.add(key);
    if (!Array.isArray(entry.holders) || entry.holders.length > MAX_HOLDERS) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holders are invalid.');
    const ids = new Set<string>();
    for (const holder of entry.holders) {
      if (!/^[0-9a-f-]{36}$/i.test(holder.leaseId) || ids.has(holder.leaseId)) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder lease ID is invalid.');
      ids.add(holder.leaseId);
      bounded(holder.ownerId, 256, 'resource ownerId');
      if (!Number.isSafeInteger(holder.pid) || holder.pid < 1) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder PID is invalid.');
      if (holder.mode !== 'shared' && holder.mode !== 'exclusive') throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder mode is invalid.');
      if (!Number.isFinite(Date.parse(holder.acquiredAt))) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder timestamp is invalid.');
    }
  }
  return state;
}

function reapDeadHolders(state: LeaseState): void {
  for (const entry of state.resources) entry.holders = entry.holders.filter((holder) => processAlive(holder.pid));
  state.resources = state.resources.filter((entry) => entry.holders.length > 0);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
