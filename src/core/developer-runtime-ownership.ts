import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import {
  currentProcessInstance,
  inspectProcessInstance,
  sameProcessInstance,
  type ProcessInstanceIdentity,
  type ProcessInstanceInspector,
  validProcessInstance
} from './process-instance.ts';

export type DeveloperRuntimeOwnershipPhase =
  | 'LAUNCH_INTENT'
  | 'RUNNING'
  | 'TERMINATION_PENDING'
  | 'EXITED'
  | 'TERMINATED'
  | 'AMBIGUOUS';

export interface DeveloperRuntimeOwnershipRecord {
  schemaVersion: 1;
  processSessionId: string;
  developerSessionId: string;
  phase: DeveloperRuntimeOwnershipPhase;
  launcherProcessInstance: ProcessInstanceIdentity;
  processInstance?: ProcessInstanceIdentity;
  ports: number[];
  createdAt: string;
  updatedAt: string;
}

interface OwnershipState {
  version: 1;
  records: DeveloperRuntimeOwnershipRecord[];
}

const STATE_OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'DEVELOPER_RUNTIME_OWNERSHIP_CORRUPT',
  invalidMessage: 'Developer runtime ownership state is invalid.'
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9._:@/+\-=]{1,512}$/;
const ACTIVE_PHASES = new Set<DeveloperRuntimeOwnershipPhase>([
  'LAUNCH_INTENT',
  'RUNNING',
  'TERMINATION_PENDING',
  'AMBIGUOUS'
]);
const MAX_RECORDS = 20_000;
const MAX_PORTS_PER_SESSION = 128;

export class DeveloperRuntimeOwnershipStore {
  #file: string;
  #lockFile: string;
  #inspect: ProcessInstanceInspector;
  #ownerProcess?: ProcessInstanceIdentity;

  constructor(
    stateDir: string,
    options: {
      inspectProcessInstance?: ProcessInstanceInspector;
      processInstance?: ProcessInstanceIdentity;
    } = {}
  ) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'developer-runtime-ownership.json');
    this.#lockFile = path.join(root, 'developer-runtime-ownership.lock');
    this.#inspect = options.inspectProcessInstance ?? inspectProcessInstance;
    this.#ownerProcess = options.processInstance;
  }

  async beginLaunch(input: {
    processSessionId: string;
    developerSessionId: string;
    ports?: number[];
    now?: string;
  }): Promise<DeveloperRuntimeOwnershipRecord> {
    const processSessionId = validUuid(input.processSessionId, 'processSessionId');
    const developerSessionId = validId(input.developerSessionId, 'developerSessionId');
    const ports = normalizePorts(input.ports ?? []);
    const now = canonicalIso(input.now ?? new Date().toISOString(), 'now');
    const launcherProcessInstance = this.#ownerProcess ?? await currentProcessInstance();
    let created!: DeveloperRuntimeOwnershipRecord;

    await this.#mutate(async (state) => {
      await reconcileDeadRecords(state, this.#inspect, now);
      if (state.records.some((item) => item.processSessionId === processSessionId)) {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_SESSION_REUSE',
          'processSessionId is already bound to durable runtime ownership.'
        );
      }
      assertPortsAvailable(state, ports, processSessionId);
      if (state.records.length >= MAX_RECORDS) {
        throw new OperatorError('DEVELOPER_RUNTIME_OWNERSHIP_LIMIT', 'Developer runtime ownership table is full.');
      }
      created = {
        schemaVersion: 1,
        processSessionId,
        developerSessionId,
        phase: 'LAUNCH_INTENT',
        launcherProcessInstance,
        ports,
        createdAt: now,
        updatedAt: now
      };
      state.records.push(created);
      state.records.sort((a, b) => a.processSessionId.localeCompare(b.processSessionId));
    });

    return structuredClone(created);
  }

  async commitLaunch(
    processSessionIdInput: string,
    identityInput: ProcessInstanceIdentity,
    nowInput = new Date().toISOString()
  ): Promise<DeveloperRuntimeOwnershipRecord> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const identity = validProcessInstance(identityInput);
    if (!identity) throw new OperatorError('DEVELOPER_RUNTIME_PROCESS_IDENTITY_INVALID', 'Process identity is invalid.');
    const now = canonicalIso(nowInput, 'now');
    let committed!: DeveloperRuntimeOwnershipRecord;

    await this.#mutate(async (state) => {
      const record = requiredRecord(state, processSessionId);
      if (record.phase !== 'LAUNCH_INTENT') {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_TRANSITION_INVALID',
          'Only a launch intent may commit process ownership.'
        );
      }
      assertPortsAvailable(state, record.ports, processSessionId);
      record.processInstance = identity;
      record.phase = 'RUNNING';
      record.updatedAt = now;
      committed = structuredClone(record);
    });
    return committed;
  }

  async abortLaunch(processSessionIdInput: string, nowInput = new Date().toISOString()): Promise<void> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const now = canonicalIso(nowInput, 'now');
    await this.#mutate((state) => {
      const record = requiredRecord(state, processSessionId);
      if (record.phase !== 'LAUNCH_INTENT') {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_TRANSITION_INVALID',
          'Only an uncommitted launch intent may be aborted.'
        );
      }
      record.phase = 'TERMINATED';
      record.updatedAt = now;
    });
  }

  /**
   * Called after provider restart. A launch intent with no exact process identity
   * is intentionally promoted to AMBIGUOUS because the process may have started
   * in the crash window before ownership commit.
   */
  async recover(nowInput = new Date().toISOString()): Promise<DeveloperRuntimeOwnershipRecord[]> {
    const now = canonicalIso(nowInput, 'now');
    let records: DeveloperRuntimeOwnershipRecord[] = [];
    await this.#mutate(async (state) => {
      for (const record of state.records) {
        if (record.phase !== 'LAUNCH_INTENT') continue;
        const launcherLive = await this.#inspect(record.launcherProcessInstance.pid);
        if (!sameProcessInstance(record.launcherProcessInstance, launcherLive)) {
          record.phase = 'AMBIGUOUS';
          record.updatedAt = now;
        }
      }
      await reconcileDeadRecords(state, this.#inspect, now);
      records = state.records.map((item) => structuredClone(item));
    });
    return records;
  }

  async listForDeveloperSession(
    developerSessionIdInput: string,
    nowInput = new Date().toISOString()
  ): Promise<DeveloperRuntimeOwnershipRecord[]> {
    const developerSessionId = validId(developerSessionIdInput, 'developerSessionId');
    const now = canonicalIso(nowInput, 'now');
    let rows: DeveloperRuntimeOwnershipRecord[] = [];
    await this.#mutate(async (state) => {
      await reconcileDeadRecords(state, this.#inspect, now);
      rows = state.records
        .filter((item) => item.developerSessionId === developerSessionId)
        .map((item) => structuredClone(item));
    });
    return rows;
  }

  async listAll(nowInput = new Date().toISOString()): Promise<DeveloperRuntimeOwnershipRecord[]> {
    const now = canonicalIso(nowInput, 'now');
    let rows: DeveloperRuntimeOwnershipRecord[] = [];
    await this.#mutate(async (state) => {
      await reconcileDeadRecords(state, this.#inspect, now);
      rows = state.records.map((item) => structuredClone(item));
    });
    return rows;
  }

  async get(
    processSessionIdInput: string,
    nowInput = new Date().toISOString()
  ): Promise<DeveloperRuntimeOwnershipRecord> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const now = canonicalIso(nowInput, 'now');
    let row!: DeveloperRuntimeOwnershipRecord;
    await this.#mutate(async (state) => {
      await reconcileDeadRecords(state, this.#inspect, now);
      row = structuredClone(requiredRecord(state, processSessionId));
    });
    return row;
  }

  async claimTermination(
    processSessionIdInput: string,
    nowInput = new Date().toISOString()
  ): Promise<ProcessInstanceIdentity | null> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const now = canonicalIso(nowInput, 'now');
    let identity: ProcessInstanceIdentity | null = null;

    await this.#mutate(async (state) => {
      const record = requiredRecord(state, processSessionId);
      if (record.phase === 'AMBIGUOUS' || record.phase === 'LAUNCH_INTENT') {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_OWNERSHIP_AMBIGUOUS',
          'Process ownership is ambiguous; exact termination authority cannot be established.'
        );
      }
      if (record.phase === 'EXITED' || record.phase === 'TERMINATED') {
        identity = null;
        return;
      }
      if (!record.processInstance) {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_PROCESS_IDENTITY_MISSING',
          'Running ownership record has no exact process identity.'
        );
      }
      const live = await this.#inspect(record.processInstance.pid);
      if (!sameProcessInstance(record.processInstance, live)) {
        record.phase = 'EXITED';
        record.updatedAt = now;
        identity = null;
        return;
      }
      record.phase = 'TERMINATION_PENDING';
      record.updatedAt = now;
      identity = structuredClone(record.processInstance);
    });
    return identity;
  }

  async markExited(
    processSessionIdInput: string,
    identityInput: ProcessInstanceIdentity,
    nowInput = new Date().toISOString()
  ): Promise<void> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const identity = validProcessInstance(identityInput);
    if (!identity) throw new OperatorError('DEVELOPER_RUNTIME_PROCESS_IDENTITY_INVALID', 'Process identity is invalid.');
    const now = canonicalIso(nowInput, 'now');
    await this.#mutate((state) => {
      const record = requiredRecord(state, processSessionId);
      if (!record.processInstance || !sameProcessInstance(record.processInstance, identity)) {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_PROCESS_IDENTITY_MISMATCH',
          'Exit observation does not match the owned process instance.'
        );
      }
      if (record.phase === 'TERMINATED' || record.phase === 'EXITED') return;
      if (record.phase === 'AMBIGUOUS' || record.phase === 'LAUNCH_INTENT') {
        throw new OperatorError('DEVELOPER_RUNTIME_TRANSITION_INVALID', 'Ambiguous launch ownership cannot accept an exit claim.');
      }
      record.phase = 'EXITED';
      record.updatedAt = now;
    });
  }

  async markTerminated(
    processSessionIdInput: string,
    identityInput: ProcessInstanceIdentity,
    nowInput = new Date().toISOString()
  ): Promise<void> {
    const processSessionId = validUuid(processSessionIdInput, 'processSessionId');
    const identity = validProcessInstance(identityInput);
    if (!identity) throw new OperatorError('DEVELOPER_RUNTIME_PROCESS_IDENTITY_INVALID', 'Process identity is invalid.');
    const now = canonicalIso(nowInput, 'now');

    await this.#mutate(async (state) => {
      const record = requiredRecord(state, processSessionId);
      if (!record.processInstance || !sameProcessInstance(record.processInstance, identity)) {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_PROCESS_IDENTITY_MISMATCH',
          'Termination confirmation does not match the owned process instance.'
        );
      }
      const live = await this.#inspect(identity.pid);
      if (sameProcessInstance(identity, live)) {
        throw new OperatorError(
          'DEVELOPER_RUNTIME_TERMINATION_UNPROVEN',
          'Exact owned process instance is still alive.'
        );
      }
      record.phase = 'TERMINATED';
      record.updatedAt = now;
    });
  }

  async #read(): Promise<OwnershipState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError(
        'DEVELOPER_RUNTIME_OWNERSHIP_CORRUPT',
        'Developer runtime ownership state could not be read.'
      );
    }
  }

  async #mutate(mutator: (state: OwnershipState) => void | Promise<void>): Promise<void> {
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
    const processInstance = this.#ownerProcess ?? await currentProcessInstance();
    const owner = {
      id: crypto.randomUUID(),
      pid: processInstance.pid,
      processInstance
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const handle = await fs.open(this.#lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
        await handle.close();
        return async () => {
          try {
            const current = JSON.parse(await fs.readFile(this.#lockFile, 'utf8')) as { id?: unknown };
            if (current.id !== owner.id) {
              throw new OperatorError(
                'DEVELOPER_RUNTIME_OWNERSHIP_LOCK_LOST',
                'Developer runtime ownership coordinator lock changed.'
              );
            }
            await fs.rm(this.#lockFile);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new OperatorError(
                'DEVELOPER_RUNTIME_OWNERSHIP_LOCK_LOST',
                'Developer runtime ownership coordinator lock disappeared.'
              );
            }
            throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      try {
        const current = JSON.parse(await fs.readFile(this.#lockFile, 'utf8')) as {
          pid?: unknown;
          processInstance?: unknown;
        };
        const pid = Number(current.pid);
        const stored = validProcessInstance(current.processInstance);
        const live = Number.isSafeInteger(pid) && pid > 0 ? await this.#inspect(pid) : null;
        if (Number.isSafeInteger(pid) && pid > 0 && (stored ? !sameProcessInstance(stored, live) : live === null)) {
          await fs.rm(this.#lockFile, { force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    throw new OperatorError(
      'DEVELOPER_RUNTIME_OWNERSHIP_LOCK_BUSY',
      'Developer runtime ownership coordinator is busy.',
      { retryable: true }
    );
  }
}

async function reconcileDeadRecords(
  state: OwnershipState,
  inspector: ProcessInstanceInspector,
  now: string
): Promise<void> {
  const cache = new Map<number, ProcessInstanceIdentity | null>();
  for (const record of state.records) {
    if (!record.processInstance) continue;
    if (!['RUNNING', 'TERMINATION_PENDING'].includes(record.phase)) continue;
    if (!cache.has(record.processInstance.pid)) {
      cache.set(record.processInstance.pid, await inspector(record.processInstance.pid));
    }
    if (!sameProcessInstance(record.processInstance, cache.get(record.processInstance.pid) ?? null)) {
      record.phase = 'EXITED';
      record.updatedAt = now;
    }
  }
}

function assertPortsAvailable(
  state: OwnershipState,
  ports: number[],
  selfProcessSessionId: string
): void {
  if (ports.length === 0) return;
  const requested = new Set(ports);
  for (const record of state.records) {
    if (record.processSessionId === selfProcessSessionId || !ACTIVE_PHASES.has(record.phase)) continue;
    const conflict = record.ports.find((port) => requested.has(port));
    if (conflict !== undefined) {
      throw new OperatorError(
        'DEVELOPER_RUNTIME_PORT_BUSY',
        'A declared Developer Session port is already owned or unresolved.',
        {
          retryable: true,
          details: {
            port: conflict,
            developerSessionId: record.developerSessionId,
            processSessionId: record.processSessionId,
            phase: record.phase
          }
        }
      );
    }
  }
}

function requiredRecord(
  state: OwnershipState,
  processSessionId: string
): DeveloperRuntimeOwnershipRecord {
  const record = state.records.find((item) => item.processSessionId === processSessionId);
  if (!record) {
    throw new OperatorError(
      'DEVELOPER_RUNTIME_SESSION_NOT_FOUND',
      'Developer runtime ownership record was not found.'
    );
  }
  return record;
}

function validateState(input: unknown): OwnershipState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw corrupt('Ownership state must be an object.');
  }
  const raw = input as OwnershipState;
  if (raw.version !== 1 || !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) {
    throw corrupt('Ownership state shape is invalid.');
  }
  const ids = new Set<string>();
  const records = raw.records.map((item) => validateRecord(item));
  for (const record of records) {
    if (ids.has(record.processSessionId)) throw corrupt('Ownership state has duplicate processSessionId.');
    ids.add(record.processSessionId);
  }
  return { version: 1, records };
}

function validateRecord(input: unknown): DeveloperRuntimeOwnershipRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Ownership record is invalid.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('Ownership record schemaVersion must be 1.');
  const processSessionId = validUuid(raw.processSessionId, 'processSessionId');
  const developerSessionId = validId(raw.developerSessionId, 'developerSessionId');
  const phases: DeveloperRuntimeOwnershipPhase[] = [
    'LAUNCH_INTENT',
    'RUNNING',
    'TERMINATION_PENDING',
    'EXITED',
    'TERMINATED',
    'AMBIGUOUS'
  ];
  if (typeof raw.phase !== 'string' || !phases.includes(raw.phase as DeveloperRuntimeOwnershipPhase)) {
    throw corrupt('Ownership phase is invalid.');
  }
  const launcherProcessInstance = validProcessInstance(raw.launcherProcessInstance);
  if (!launcherProcessInstance) {
    throw corrupt('Ownership launcher process identity is invalid.');
  }
  const processInstance = raw.processInstance === undefined
    ? undefined
    : validProcessInstance(raw.processInstance);
  if (raw.processInstance !== undefined && !processInstance) {
    throw corrupt('Ownership process identity is invalid.');
  }
  if (['RUNNING', 'TERMINATION_PENDING', 'EXITED', 'TERMINATED'].includes(String(raw.phase)) && !processInstance) {
    throw corrupt('Committed ownership phase requires an exact process identity.');
  }
  if (['LAUNCH_INTENT', 'AMBIGUOUS'].includes(String(raw.phase)) && processInstance) {
    throw corrupt('Uncommitted ownership phase may not claim a process identity.');
  }
  const ports = normalizePorts(raw.ports);
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw corrupt('updatedAt precedes createdAt.');
  return {
    schemaVersion: 1,
    processSessionId,
    developerSessionId,
    phase: raw.phase as DeveloperRuntimeOwnershipPhase,
    launcherProcessInstance,
    ...(processInstance ? { processInstance } : {}),
    ports,
    createdAt,
    updatedAt
  };
}

function normalizePorts(input: unknown): number[] {
  if (!Array.isArray(input) || input.length > MAX_PORTS_PER_SESSION) {
    throw new OperatorError('DEVELOPER_RUNTIME_PORT_INVALID', 'Declared port list is invalid.');
  }
  const ports = input.map((value) => {
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new OperatorError('DEVELOPER_RUNTIME_PORT_INVALID', 'Declared ports must be integers from 1 to 65535.');
    }
    return port;
  });
  return [...new Set(ports)].sort((a, b) => a - b);
}

function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!UUID.test(value)) {
    throw new OperatorError('DEVELOPER_RUNTIME_OWNERSHIP_INPUT_INVALID', label + ' must be a UUID.');
  }
  return value;
}

function validId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !ID.test(input)) {
    throw new OperatorError('DEVELOPER_RUNTIME_OWNERSHIP_INPUT_INVALID', label + ' is invalid.');
  }
  return input;
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new OperatorError('DEVELOPER_RUNTIME_OWNERSHIP_INPUT_INVALID', label + ' must be canonical ISO.');
  }
  return value;
}

function corrupt(message: string): OperatorError {
  return new OperatorError('DEVELOPER_RUNTIME_OWNERSHIP_CORRUPT', message);
}
