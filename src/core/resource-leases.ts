import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { resourceKeysConflict } from './resource-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import {
  currentProcessInstance,
  observeProcessInstance,
  sameProcessInstance,
  type ProcessInstanceIdentity,
  type ProcessInstanceObservation,
  type ProcessInstanceObserver,
  validProcessInstance
} from './process-instance.ts';

export type ResourceLeaseMode = 'shared' | 'exclusive';

interface Holder {
  leaseId: string;
  ownerId: string;
  pid: number;
  processInstance?: ProcessInstanceIdentity;
  mode: ResourceLeaseMode;
  acquiredAt: string;
}

interface ResourceEntry {
  key: string;
  holders: Holder[];
}

interface ResourceQuarantine {
  actionId: string;
  key: string;
  armedAt: string;
}

interface LeaseState {
  version: 2;
  resources: ResourceEntry[];
  quarantines: ResourceQuarantine[];
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
const MAX_QUARANTINES = 20_000;
const STATE_OPTIONS = {
  maxBytes: 16 * 1024 * 1024,
  errorCode: 'RESOURCE_LEASE_CORRUPT',
  invalidMessage: 'Resource lease state is invalid.'
} as const;

export class ResourceLeaseStore {
  #file: string;
  #lockFile: string;
  #observeProcessInstance: ProcessInstanceObserver;
  #processInstance?: ProcessInstanceIdentity;

  constructor(stateDir: string, options: {
    observeProcessInstance?: ProcessInstanceObserver;
    /** @deprecated test-only compatibility hook; null is treated as unknown, never confirmed dead. */
    inspectProcessInstance?: (pid: number) => Promise<ProcessInstanceIdentity | null>;
    processInstance?: ProcessInstanceIdentity;
  } = {}) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'resource-leases.json');
    this.#lockFile = path.join(root, 'resource-leases.lock');
    this.#observeProcessInstance = options.observeProcessInstance
      ?? (options.inspectProcessInstance
        ? async (pid) => {
            try {
              const identity = await options.inspectProcessInstance!(pid);
              return identity ? { status: 'live', identity } : { status: 'unknown' };
            } catch {
              return { status: 'unknown' };
            }
          }
        : observeProcessInstance);
    this.#processInstance = options.processInstance;
  }

  async acquire(
    ownerIdInput: string,
    keysInput: string[],
    mode: ResourceLeaseMode,
    options: { mutationActionId?: string } = {}
  ): Promise<ResourceLease> {
    const ownerId = bounded(ownerIdInput, 256, 'ownerId');
    const keys = normalizeKeys(keysInput);
    if (keys.length === 0) return noOpLease(ownerId, mode);
    if (mode !== 'shared' && mode !== 'exclusive') throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', 'Resource lease mode is invalid.');

    const leaseId = crypto.randomUUID();
    const mutationActionId = options.mutationActionId === undefined ? undefined : bounded(options.mutationActionId, 512, 'mutationActionId');
    const processInstance = this.#processInstance ?? await currentProcessInstance();
    await this.#mutate(async (state) => {
      await reapDeadHolders(state, this.#observeProcessInstance);
      if (mode === 'exclusive') {
        for (const key of keys) {
          const quarantine = state.quarantines.find((item) =>
            item.actionId !== mutationActionId && resourceKeysConflict(item.key, key)
          );
          if (quarantine) {
            throw new OperatorError('RESOURCE_QUARANTINED', `Resource ${key} has unresolved mutation state from action ${quarantine.actionId}.`, {
              retryable: true,
              details: { key, quarantinedKey: quarantine.key, actionId: quarantine.actionId, armedAt: quarantine.armedAt }
            });
          }
        }
      }
      for (const key of keys) {
        const conflictingEntries = state.resources.filter((item) => resourceKeysConflict(item.key, key));
        for (const entry of conflictingEntries) {
          const conflicts = entry.holders.filter((holder) =>
            holder.ownerId !== ownerId && (mode === 'exclusive' || holder.mode === 'exclusive')
          );
          if (conflicts.length > 0) {
            throw new OperatorError('RESOURCE_BUSY', `Resource ${key} conflicts with another active execution.`, {
              retryable: true,
              details: {
                key,
                conflictingKey: entry.key,
                holders: conflicts.map((holder) => ({ ownerId: holder.ownerId, mode: holder.mode }))
              }
            });
          }
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
        entry.holders.push({ leaseId, ownerId, pid: processInstance.pid, processInstance, mode, acquiredAt: now });
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
        if (!entry?.holders.some((holder) => holder.leaseId === leaseId && holder.ownerId === ownerId && holder.pid === processInstance.pid &&
          holder.processInstance && sameProcessInstance(processInstance, holder.processInstance) && holder.mode === mode)) {
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

  async quarantine(actionIdInput: string, keysInput: string[]): Promise<void> {
    const actionId = bounded(actionIdInput, 512, 'actionId');
    const keys = normalizeKeys(keysInput);
    if (keys.length === 0) return;
    await this.#mutate((state) => {
      for (const key of keys) {
        const conflict = state.quarantines.find((item) => item.actionId !== actionId && resourceKeysConflict(item.key, key));
        if (conflict) {
          throw new OperatorError('RESOURCE_QUARANTINED', `Resource ${key} is already quarantined by unresolved action ${conflict.actionId}.`, {
            retryable: true,
            details: { key, quarantinedKey: conflict.key, actionId: conflict.actionId, armedAt: conflict.armedAt }
          });
        }
      }
      const now = new Date().toISOString();
      for (const key of keys) {
        if (state.quarantines.some((item) => item.actionId === actionId && item.key === key)) continue;
        if (state.quarantines.length >= MAX_QUARANTINES) throw new OperatorError('RESOURCE_QUARANTINE_LIMIT', 'Resource quarantine table is full.');
        state.quarantines.push({ actionId, key, armedAt: now });
      }
      state.quarantines.sort((a, b) => a.key.localeCompare(b.key) || a.actionId.localeCompare(b.actionId));
    });
  }

  async clearQuarantine(actionIdInput: string): Promise<void> {
    const actionId = bounded(actionIdInput, 512, 'actionId');
    await this.#mutate((state) => {
      state.quarantines = state.quarantines.filter((item) => item.actionId !== actionId);
    });
  }

  async inspect(): Promise<LeaseState> {
    const state = await this.#read();
    await reapDeadHolders(state, this.#observeProcessInstance);
    return structuredClone(state);
  }

  async #read(): Promise<LeaseState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, resources: [], quarantines: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state could not be read.');
    }
  }

  async #mutate(mutator: (state: LeaseState) => void | Promise<void>): Promise<void> {
    const release = await this.#acquireCoordinatorLock();
    try {
      const state = await this.#read();
      await mutator(state);
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STATE_OPTIONS);
    } finally {
      await release();
    }
  }

  async #acquireCoordinatorLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.#lockFile), { recursive: true, mode: 0o700 });
    const processInstance = this.#processInstance ?? await currentProcessInstance();
    const owner = { id: crypto.randomUUID(), pid: processInstance.pid, processInstance };
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
        const current = JSON.parse(await fs.readFile(this.#lockFile, 'utf8')) as { pid?: unknown; processInstance?: unknown };
        const pid = Number(current.pid);
        const storedIdentity = validProcessInstance(current.processInstance);
        const observation: ProcessInstanceObservation = Number.isSafeInteger(pid) && pid > 0
          ? await this.#observeProcessInstance(pid)
          : { status: 'dead' };
        const stale = observation.status === 'dead'
          || (observation.status === 'live' && storedIdentity && observation.identity
            ? !sameProcessInstance(storedIdentity, observation.identity)
            : false);
        if (Number.isSafeInteger(pid) && pid > 0 && stale) {
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
  const raw = input as { version?: unknown; resources?: unknown; quarantines?: unknown };
  const version = Number(raw.version);
  if (![1, 2].includes(version) || !Array.isArray(raw.resources) || raw.resources.length > MAX_RESOURCES) {
    throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource lease state shape is invalid.');
  }
  const resources = raw.resources as ResourceEntry[];
  const keys = new Set<string>();
  for (const entry of resources) {
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
      if (holder.processInstance !== undefined) {
        const identity = validProcessInstance(holder.processInstance);
        if (!identity || identity.pid !== holder.pid) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder process identity is invalid.');
      }
      if (holder.mode !== 'shared' && holder.mode !== 'exclusive') throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder mode is invalid.');
      if (!Number.isFinite(Date.parse(holder.acquiredAt))) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource holder timestamp is invalid.');
    }
  }

  const quarantines = version === 1 ? [] : raw.quarantines;
  if (!Array.isArray(quarantines) || quarantines.length > MAX_QUARANTINES) {
    throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource quarantine state is invalid.');
  }
  const quarantineIds = new Set<string>();
  const normalizedQuarantines: ResourceQuarantine[] = quarantines.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource quarantine entry is invalid.');
    const value = item as ResourceQuarantine;
    const actionId = bounded(value.actionId, 512, 'quarantine actionId');
    const key = bounded(value.key, 1024, 'quarantine key');
    const armedAt = String(value.armedAt ?? '');
    if (!Number.isFinite(Date.parse(armedAt))) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource quarantine timestamp is invalid.');
    const identity = actionId + '\u0000' + key;
    if (quarantineIds.has(identity)) throw new OperatorError('RESOURCE_LEASE_CORRUPT', 'Resource quarantine entries must be unique.');
    quarantineIds.add(identity);
    return { actionId, key, armedAt };
  });

  return { version: 2, resources, quarantines: normalizedQuarantines };
}

async function reapDeadHolders(state: LeaseState, observer: ProcessInstanceObserver): Promise<void> {
  const observations = new Map<number, ProcessInstanceObservation>();
  for (const holder of state.resources.flatMap((entry) => entry.holders)) {
    if (!observations.has(holder.pid)) {
      let observation: ProcessInstanceObservation;
      try { observation = await observer(holder.pid); }
      catch { observation = { status: 'unknown' }; }
      observations.set(holder.pid, observation);
    }
  }
  for (const entry of state.resources) entry.holders = entry.holders.filter((holder) => {
    const observation = observations.get(holder.pid) ?? { status: 'unknown' };
    if (observation.status === 'dead') return false;
    if (observation.status === 'unknown') return true;
    if (!holder.processInstance || !observation.identity) return true;
    return sameProcessInstance(holder.processInstance, observation.identity);
  });
  state.resources = state.resources.filter((entry) => entry.holders.length > 0);
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('RESOURCE_LEASE_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
