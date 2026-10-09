import path from 'node:path';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { ProcessInstanceIdentity } from './process-instance.ts';

export type TerminalSessionState =
  | 'launching'
  | 'running'
  | 'exited'
  | 'terminated'
  | 'recovered'
  | 'stale_pid'
  | 'recovery_required'
  | 'failed';

export interface DurableTerminalSession {
  sessionId: string;
  executable: string;
  pid?: number;
  processInstance?: ProcessInstanceIdentity;
  startedAt: string;
  updatedAt: string;
  state: TerminalSessionState;
  revision: number;
  terminalReason?: string;
}

interface TerminalSessionStoreState {
  version: 1;
  sessions: DurableTerminalSession[];
}

const MAX_RECORDS = 64;
const MAX_ACTIVE_RECORDS = 32;
const MAX_TERMINAL_AGE_MS = 60 * 60_000;
const STORE_OPTIONS = {
  maxBytes: 256 * 1024,
  errorCode: 'TERMINAL_SESSION_OWNERSHIP_CORRUPT',
  invalidMessage: 'Durable terminal-session ownership state is invalid.'
} as const;

const TERMINAL_STATES = new Set<TerminalSessionState>(['exited', 'terminated', 'recovered', 'stale_pid', 'failed']);
const TRANSITIONS: Readonly<Record<TerminalSessionState, readonly TerminalSessionState[]>> = {
  launching: ['running', 'failed', 'recovery_required'],
  running: ['exited', 'terminated', 'recovered', 'stale_pid', 'recovery_required', 'failed'],
  exited: ['terminated', 'recovered', 'stale_pid'],
  terminated: [],
  recovered: [],
  stale_pid: [],
  recovery_required: ['recovered', 'stale_pid', 'exited'],
  failed: []
};

export class TerminalSessionStore {
  readonly file: string;
  #serial: Promise<void> = Promise.resolve();
  #clock: () => Date;

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.file = path.join(path.resolve(stateDir), 'terminal-sessions.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async list(): Promise<DurableTerminalSession[]> {
    await this.#serial;
    return structuredClone((await this.#read()).sessions);
  }

  async get(sessionId: string): Promise<DurableTerminalSession | undefined> {
    const id = uuid(sessionId);
    return (await this.list()).find((record) => record.sessionId === id);
  }

  async prepare(input: { sessionId: string; executable: string }): Promise<DurableTerminalSession> {
    return await this.#mutate((state) => {
      pruneTerminal(state, this.#clock().getTime());
      if (state.sessions.some((record) => record.sessionId === input.sessionId)) {
        throw new OperatorError('TERMINAL_SESSION_STATE_INVALID', 'Terminal session id is already registered.');
      }
      if (state.sessions.filter(terminalSessionIsActive).length >= MAX_ACTIVE_RECORDS) {
        throw new OperatorError('TERMINAL_SESSION_OWNERSHIP_LIMIT', 'At most 32 active or unresolved durable terminal-session ownership records may exist.');
      }
      if (state.sessions.length >= MAX_RECORDS) {
        throw new OperatorError('TERMINAL_SESSION_OWNERSHIP_LIMIT', 'Durable terminal-session ownership capacity is exhausted by active or unresolved records.');
      }
      const now = this.#clock().toISOString();
      const record = normalizeRecord({
        sessionId: input.sessionId,
        executable: input.executable,
        startedAt: now,
        updatedAt: now,
        state: 'launching',
        revision: 1
      });
      state.sessions.push(record);
      return record;
    });
  }

  async activate(sessionId: string, identity: ProcessInstanceIdentity): Promise<DurableTerminalSession> {
    return await this.transition(sessionId, 'running', { identity });
  }

  async bindProcess(sessionId: string, identity: ProcessInstanceIdentity): Promise<DurableTerminalSession> {
    const current = await this.get(sessionId);
    if (!current || current.state !== 'launching') throw new OperatorError('TERMINAL_SESSION_STATE_INVALID', 'Process identity may only be bound to a launching terminal session.');
    return await this.transition(sessionId, 'launching', { identity });
  }

  async transition(
    sessionId: string,
    next: TerminalSessionState,
    options: { identity?: ProcessInstanceIdentity; reason?: string } = {}
  ): Promise<DurableTerminalSession> {
    return await this.#mutate((state) => {
      const record = state.sessions.find((candidate) => candidate.sessionId === uuid(sessionId));
      if (!record) throw new OperatorError('TERMINAL_SESSION_NOT_FOUND', 'Durable terminal session was not found.');
      if (record.state === next && next !== 'launching') {
        throw new OperatorError('TERMINAL_SESSION_STATE_INVALID', `Terminal session is already ${next}.`);
      }
      if (record.state !== next && !TRANSITIONS[record.state].includes(next)) {
        throw new OperatorError('TERMINAL_SESSION_STATE_INVALID', `Terminal session cannot move from ${record.state} to ${next}.`);
      }
      const identity = options.identity ?? record.processInstance;
      if (record.processInstance && options.identity
        && (record.processInstance.pid !== options.identity.pid || record.processInstance.started !== options.identity.started)) {
        throw new OperatorError('TERMINAL_SESSION_STATE_INVALID', 'Bound process identity cannot be replaced.');
      }
      if (next === 'running' && !identity) throw corrupt('A running record requires an exact process identity.');
      record.state = next;
      if (identity) {
        record.pid = identity.pid;
        record.processInstance = structuredClone(identity);
      }
      record.updatedAt = this.#clock().toISOString();
      record.revision += 1;
      if (options.reason !== undefined) record.terminalReason = bounded(options.reason, 256, 'terminalReason');
      return normalizeRecord(record);
    });
  }

  async #read(): Promise<TerminalSessionStoreState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: [] };
      if (error instanceof OperatorError) throw error;
      throw corrupt('State could not be parsed.');
    }
  }

  async #mutate<T>(fn: (state: TerminalSessionStoreState) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(() => withDurableStateLock(this.file, async () => {
      const state = await this.#read();
      output = await fn(state);
      const validated = validateState(state);
      await writeDurableStateText(this.file, `${JSON.stringify(validated, null, 2)}\n`, STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }
}

export function terminalSessionIsActive(record: DurableTerminalSession): boolean {
  return record.state === 'launching' || record.state === 'running' || record.state === 'recovery_required';
}

function validateState(input: unknown): TerminalSessionStoreState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'version' && key !== 'sessions')) throw corrupt('State contains unexpected fields.');
  if (raw.version !== 1 || !Array.isArray(raw.sessions) || raw.sessions.length > MAX_RECORDS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  const sessions = raw.sessions.map(normalizeRecord);
  for (const record of sessions) {
    if (ids.has(record.sessionId)) throw corrupt('Session ids must be unique.');
    ids.add(record.sessionId);
  }
  return { version: 1, sessions };
}

function normalizeRecord(input: unknown): DurableTerminalSession {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Session record must be an object.');
  const value = input as Record<string, unknown>;
  const allowed = new Set(['sessionId', 'executable', 'pid', 'processInstance', 'startedAt', 'updatedAt', 'state', 'revision', 'terminalReason']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw corrupt('Session record contains unexpected fields.');
  const state = value.state;
  if (typeof state !== 'string' || !(state in TRANSITIONS)) throw corrupt('Session state is invalid.');
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) throw corrupt('Session revision is invalid.');
  const record: DurableTerminalSession = {
    sessionId: uuid(value.sessionId),
    executable: bounded(value.executable, 512, 'executable'),
    startedAt: iso(value.startedAt),
    updatedAt: iso(value.updatedAt),
    state: state as TerminalSessionState,
    revision: value.revision
  };
  if (value.pid !== undefined || value.processInstance !== undefined) {
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fff_ffff) throw corrupt('PID is invalid.');
    if (!value.processInstance || typeof value.processInstance !== 'object' || Array.isArray(value.processInstance)) throw corrupt('Process identity is invalid.');
    const identity = value.processInstance as Record<string, unknown>;
    if (Object.keys(identity).some((key) => key !== 'pid' && key !== 'started')) throw corrupt('Process identity contains unexpected fields.');
    if (typeof identity.pid !== 'number' || identity.pid !== value.pid || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid > 0x7fff_ffff) throw corrupt('Process identity PID is invalid.');
    if (typeof identity.started !== 'string' || !validStartedIdentity(identity.started)) throw corrupt('Process start identity is invalid.');
    record.pid = value.pid;
    record.processInstance = { pid: identity.pid, started: identity.started };
  }
  if (record.state === 'running' && !record.processInstance) throw corrupt('Running session lacks process identity.');
  if (value.terminalReason !== undefined) record.terminalReason = bounded(value.terminalReason, 256, 'terminalReason');
  return record;
}

function pruneTerminal(state: TerminalSessionStoreState, now: number): void {
  state.sessions = state.sessions.filter((record) => !TERMINAL_STATES.has(record.state) || now - Date.parse(record.updatedAt) <= MAX_TERMINAL_AGE_MS);
  if (state.sessions.length < MAX_RECORDS) return;
  const terminal = state.sessions.filter((record) => TERMINAL_STATES.has(record.state)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  while (state.sessions.length >= MAX_RECORDS && terminal.length > 0) {
    const remove = terminal.shift()!;
    state.sessions = state.sessions.filter((record) => record.sessionId !== remove.sessionId);
  }
}

function uuid(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) throw corrupt('Session id is invalid.');
  return input.toLowerCase();
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw corrupt(`${label} is invalid.`);
  return input;
}

function iso(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(Date.parse(input)).toISOString() !== input) throw corrupt('Timestamp is invalid.');
  return input;
}

function validStartedIdentity(value: string): boolean {
  if (value.length < 1 || value.length > 256 || value.includes('\0')) return false;
  if (/^windows-filetime:\d{15,20}$/.test(value)) return true;
  if (/^linux-boot-ticks:\d{1,32}$/.test(value)) return true;
  if (/^linux-boot-id:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:ticks:\d{1,32}$/.test(value)) return true;
  if (/^ps-lstart:[^\r\n]{1,128}$/.test(value)) return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function corrupt(detail: string): OperatorError {
  return new OperatorError('TERMINAL_SESSION_OWNERSHIP_CORRUPT', `Durable terminal-session ownership state is invalid. ${detail}`);
}
