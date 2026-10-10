import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';

export type EventWaitState = 'WAITING' | 'SATISFIED' | 'TIMED_OUT' | 'CANCELLED';

export interface RuntimeEvent {
  id: string;
  type: string;
  correlationKey?: string;
  payloadDigest: string;
  occurredAt: string;
}

export interface EventWait {
  id: string;
  eventType: string;
  correlationKey?: string;
  state: EventWaitState;
  createdAt: string;
  notBefore?: string;
  deadlineAt?: string;
  wakeAt?: string;
  satisfiedBy?: string;
  satisfiedAt?: string;
  terminalAt?: string;
}

interface EventState {
  version: 1;
  events: RuntimeEvent[];
  waits: EventWait[];
}

const MAX_EVENTS = 20_000;
const MAX_WAITS = 20_000;
const DEFAULT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_TERMINAL_RETENTION_MS = 365 * 24 * 60 * 60_000;
const STATE_OPTIONS = {
  maxBytes: 24 * 1024 * 1024,
  errorCode: 'EVENT_STATE_CORRUPT',
  invalidMessage: 'Event runtime state is invalid.'
} as const;

export class DurableEventRuntime {
  #file: string;
  #clock: () => Date;
  #maxWaits: number;
  #terminalRetentionMs: number;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: {
    clock?: () => Date;
    maxWaits?: number;
    terminalRetentionMs?: number;
  } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'events.json');
    this.#clock = options.clock ?? (() => new Date());
    this.#maxWaits = boundedRuntimeInteger(options.maxWaits ?? MAX_WAITS, 1, MAX_WAITS, 'maxWaits');
    this.#terminalRetentionMs = boundedRuntimeInteger(
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS,
      1_000,
      MAX_TERMINAL_RETENTION_MS,
      'terminalRetentionMs'
    );
  }

  async wait(input: {
    waitId?: string;
    eventType: string;
    correlationKey?: string;
    notBefore?: string;
    deadlineAt?: string;
    wakeAt?: string;
  }): Promise<EventWait> {
    return await this.#mutate((state, now) => {
      const id = input.waitId ? uuid(input.waitId, 'waitId') : crypto.randomUUID();
      const existing = state.waits.find((wait) => wait.id === id);
      const candidate: EventWait = {
        id,
        eventType: boundedType(input.eventType),
        ...(input.correlationKey !== undefined ? { correlationKey: bounded(input.correlationKey, 512, 'correlationKey') } : {}),
        state: 'WAITING',
        createdAt: now.toISOString(),
        ...(input.notBefore !== undefined ? { notBefore: iso(input.notBefore, 'notBefore') } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineAt: iso(input.deadlineAt, 'deadlineAt') } : {}),
        ...(input.wakeAt !== undefined ? { wakeAt: iso(input.wakeAt, 'wakeAt') } : {})
      };
      if (candidate.deadlineAt && candidate.wakeAt && Date.parse(candidate.wakeAt) > Date.parse(candidate.deadlineAt)) {
        throw new OperatorError('EVENT_WAIT_INVALID', 'wakeAt cannot be after deadlineAt.');
      }
      if (existing) {
        const same = existing.eventType === candidate.eventType
          && existing.correlationKey === candidate.correlationKey
          && existing.notBefore === candidate.notBefore
          && existing.deadlineAt === candidate.deadlineAt
          && existing.wakeAt === candidate.wakeAt;
        if (!same) throw new OperatorError('EVENT_WAIT_ID_CONFLICT', 'waitId is already bound to a different event contract.');
        return existing;
      }
      if (state.waits.length >= this.#maxWaits) throw new OperatorError('EVENT_WAIT_LIMIT', `Event wait limit of ${this.#maxWaits} active/retained waits reached.`);
      state.waits.push(candidate);
      satisfyFromHistory(state, candidate, now.getTime());
      return candidate;
    });
  }

  async publish(input: RuntimeEvent): Promise<{ event: RuntimeEvent; satisfiedWaitIds: string[] }> {
    return await this.#mutate((state, now) => {
      const event = validateEvent(input);
      const existing = state.events.find((item) => item.id === event.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new OperatorError('EVENT_ID_CONFLICT', 'Event id is already bound to different content.');
        return {
          event: existing,
          satisfiedWaitIds: state.waits.filter((wait) => wait.satisfiedBy === event.id).map((wait) => wait.id).sort()
        };
      }
      if (state.events.length >= MAX_EVENTS) state.events.splice(0, Math.max(1, Math.floor(MAX_EVENTS * 0.1)));
      state.events.push(event);
      const satisfiedWaitIds: string[] = [];
      for (const wait of state.waits) {
        if (wait.state !== 'WAITING' || !matches(wait, event)) continue;
        if (wait.notBefore && Date.parse(event.occurredAt) < Date.parse(wait.notBefore)) continue;
        if (wait.deadlineAt && Date.parse(event.occurredAt) > Date.parse(wait.deadlineAt)) continue;
        wait.state = 'SATISFIED';
        wait.satisfiedBy = event.id;
        wait.satisfiedAt = now.toISOString();
        wait.terminalAt = wait.satisfiedAt;
        satisfiedWaitIds.push(wait.id);
      }
      return { event, satisfiedWaitIds: satisfiedWaitIds.sort() };
    });
  }

  async tick(): Promise<{ woke: string[]; timedOut: string[] }> {
    return await this.#mutate((state, now) => {
      const woke: string[] = [];
      const timedOut: string[] = [];
      for (const wait of state.waits) {
        if (wait.state !== 'WAITING') continue;
        if (wait.wakeAt && Date.parse(wait.wakeAt) <= now.getTime()) {
          wait.state = 'SATISFIED';
          wait.satisfiedAt = now.toISOString();
          wait.satisfiedBy = `timer:${wait.id}`;
          wait.terminalAt = wait.satisfiedAt;
          woke.push(wait.id);
          continue;
        }
        if (wait.deadlineAt && Date.parse(wait.deadlineAt) <= now.getTime()) {
          wait.state = 'TIMED_OUT';
          wait.terminalAt = now.toISOString();
          timedOut.push(wait.id);
        }
      }
      return { woke: woke.sort(), timedOut: timedOut.sort() };
    });
  }

  async cancel(waitIdInput: string): Promise<EventWait> {
    return await this.#mutate((state, now) => {
      const id = uuid(waitIdInput, 'waitId');
      const wait = state.waits.find((item) => item.id === id);
      if (!wait) throw new OperatorError('EVENT_WAIT_NOT_FOUND', `Event wait ${id} was not found.`);
      if (wait.state === 'WAITING') {
        wait.state = 'CANCELLED';
        wait.terminalAt = now.toISOString();
      }
      return wait;
    });
  }

  async inspect(waitIdInput: string): Promise<EventWait> {
    await this.#serial;
    const state = await this.#read();
    const id = uuid(waitIdInput, 'waitId');
    const wait = state.waits.find((item) => item.id === id);
    if (!wait) throw new OperatorError('EVENT_WAIT_NOT_FOUND', `Event wait ${id} was not found.`);
    return structuredClone(wait);
  }

  async #mutate<T>(fn: (state: EventState, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const now = this.#clock();
      pruneTerminalWaits(state, now.getTime(), this.#terminalRetentionMs);
      output = await fn(state, now);
      state.events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
      state.waits.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      await this.#write(state);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }

  async #read(): Promise<EventState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STATE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, events: [], waits: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('EVENT_STATE_CORRUPT', 'Event runtime state could not be read.');
    }
  }

  async #write(state: EventState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STATE_OPTIONS);
  }
}

function satisfyFromHistory(state: EventState, wait: EventWait, now: number): void {
  const event = state.events
    .filter((candidate) => matches(wait, candidate))
    .filter((candidate) => !wait.notBefore || Date.parse(candidate.occurredAt) >= Date.parse(wait.notBefore))
    .filter((candidate) => !wait.deadlineAt || Date.parse(candidate.occurredAt) <= Date.parse(wait.deadlineAt))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
  if (event) {
    wait.state = 'SATISFIED';
    wait.satisfiedBy = event.id;
    wait.satisfiedAt = new Date(now).toISOString();
    wait.terminalAt = wait.satisfiedAt;
  }
}

function matches(wait: EventWait, event: RuntimeEvent): boolean {
  return wait.eventType === event.type && (!wait.correlationKey || wait.correlationKey === event.correlationKey);
}

function validateEvent(input: RuntimeEvent): RuntimeEvent {
  const id = uuid(input.id, 'event.id');
  const type = boundedType(input.type);
  const occurredAt = iso(input.occurredAt, 'event.occurredAt');
  if (!/^[0-9a-f]{64}$/i.test(input.payloadDigest)) throw new OperatorError('EVENT_INPUT_INVALID', 'payloadDigest must be SHA-256.');
  return {
    id,
    type,
    ...(input.correlationKey !== undefined ? { correlationKey: bounded(input.correlationKey, 512, 'correlationKey') } : {}),
    payloadDigest: input.payloadDigest.toLowerCase(),
    occurredAt
  };
}

function validateState(input: unknown): EventState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('EVENT_STATE_CORRUPT', 'Event state must be an object.');
  const state = input as EventState;
  if (state.version !== 1 || !Array.isArray(state.events) || !Array.isArray(state.waits) || state.events.length > MAX_EVENTS || state.waits.length > MAX_WAITS) {
    throw new OperatorError('EVENT_STATE_CORRUPT', 'Event state shape is invalid.');
  }
  const eventIds = new Set<string>();
  state.events = state.events.map((raw) => {
    const event = validateEvent(raw);
    // A durable event ID must identify at most one historical event. Otherwise
    // replay and wait satisfaction can select inconsistent content for that ID.
    if (eventIds.has(event.id)) throw new OperatorError('EVENT_STATE_CORRUPT', 'Duplicate durable event id.');
    eventIds.add(event.id);
    return event;
  });
  const ids = new Set<string>();
  for (const wait of state.waits) {
    uuid(wait.id, 'wait.id');
    if (ids.has(wait.id)) throw new OperatorError('EVENT_STATE_CORRUPT', 'Duplicate event wait id.');
    ids.add(wait.id);
    boundedType(wait.eventType);
    if (!['WAITING', 'SATISFIED', 'TIMED_OUT', 'CANCELLED'].includes(wait.state)) throw new OperatorError('EVENT_STATE_CORRUPT', 'Event wait state is invalid.');
    iso(wait.createdAt, 'wait.createdAt');
    if (wait.correlationKey !== undefined) bounded(wait.correlationKey, 512, 'wait.correlationKey');
    if (wait.notBefore !== undefined) iso(wait.notBefore, 'wait.notBefore');
    if (wait.deadlineAt !== undefined) iso(wait.deadlineAt, 'wait.deadlineAt');
    if (wait.wakeAt !== undefined) iso(wait.wakeAt, 'wait.wakeAt');
    if (wait.satisfiedAt !== undefined) iso(wait.satisfiedAt, 'wait.satisfiedAt');
    if (wait.terminalAt !== undefined) iso(wait.terminalAt, 'wait.terminalAt');
    // Rehydrating a terminal flag without the event/timer receipt can report
    // fictitious success to a durable workflow. Event history is bounded, so
    // validate receipt identity even when its source event has been pruned.
    if (wait.state === 'SATISFIED') {
      if (!wait.satisfiedAt || typeof wait.satisfiedBy !== 'string') {
        throw new OperatorError('EVENT_STATE_CORRUPT', 'Satisfied wait is missing its terminal receipt.');
      }
      const timer = wait.satisfiedBy === `timer:${wait.id}` && wait.wakeAt !== undefined;
      const event = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(wait.satisfiedBy);
      if (!timer && !event) throw new OperatorError('EVENT_STATE_CORRUPT', 'Satisfied wait has an invalid event/timer receipt identity.');
      if (event) {
        // Bounded retention may legitimately prune old events. But when the
        // referenced event is still stored, its exact type, correlation and
        // time window must prove that it actually satisfied this wait.
        const source = state.events.find((candidate) => candidate.id === wait.satisfiedBy);
        if (source && (!matches(wait, source)
          || (wait.notBefore && Date.parse(source.occurredAt) < Date.parse(wait.notBefore))
          || (wait.deadlineAt && Date.parse(source.occurredAt) > Date.parse(wait.deadlineAt)))) {
          throw new OperatorError('EVENT_STATE_CORRUPT', 'Satisfied wait references an unrelated retained event.');
        }
      }
    }
    if (wait.state === 'WAITING') {
      if (wait.terminalAt) throw new OperatorError('EVENT_STATE_CORRUPT', 'Waiting event wait cannot have terminalAt.');
    } else if (!wait.terminalAt) {
      wait.terminalAt = wait.state === 'SATISFIED' && wait.satisfiedAt
        ? wait.satisfiedAt
        : wait.state === 'TIMED_OUT' && wait.deadlineAt
          ? wait.deadlineAt
          : wait.createdAt;
    }
  }
  return state;
}

function pruneTerminalWaits(state: EventState, now: number, retentionMs: number): number {
  const before = state.waits.length;
  state.waits = state.waits.filter((wait) => {
    if (wait.state === 'WAITING') return true;
    const terminalAt = wait.terminalAt ?? wait.satisfiedAt ?? wait.deadlineAt ?? wait.createdAt;
    return Date.parse(terminalAt) > now - retentionMs;
  });
  return before - state.waits.length;
}

function boundedRuntimeInteger(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw new OperatorError('EVENT_RUNTIME_CONFIG_INVALID', `${label} must be an integer between ${min} and ${max}.`);
  const value = input;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperatorError('EVENT_RUNTIME_CONFIG_INVALID', `${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boundedType(input: unknown): string {
  const value = bounded(input, 256, 'eventType');
  if (!/^[a-z][a-z0-9._:-]{0,255}$/i.test(value)) throw new OperatorError('EVENT_INPUT_INVALID', 'eventType contains unsupported characters.');
  return value;
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('EVENT_INPUT_INVALID', `${label} is invalid.`);
  return input;
}

function uuid(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new OperatorError('EVENT_INPUT_INVALID', `${label} must be a UUID.`);
  const value = input.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('EVENT_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}

function iso(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new OperatorError('EVENT_INPUT_INVALID', `${label} must be an ISO timestamp.`);
  const value = input;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('EVENT_INPUT_INVALID', `${label} must be an ISO timestamp.`);
  return value;
}
