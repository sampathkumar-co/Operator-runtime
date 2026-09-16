import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_STREAMS = 10_000;
const MAX_DELIVERIES_PER_STREAM = 10_000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_KIND = 128;
const MAX_PENDING_RETURN = 500;
const MAX_REQUIRED_CAPABILITIES = 128;
const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60_000;

type Clock = () => Date;
type JsonObject = Record<string, unknown>;

export interface RelayDeliveryAuthority {
  accountId: string;
  deviceId: string;
  generation: number;
}

export interface StoredRelayDelivery {
  seq: number;
  id: string;
  kind: string;
  payload: JsonObject;
  requiredCapabilities?: string[];
  authority?: RelayDeliveryAuthority;
  replayAuthority?: RelayDeliveryAuthority;
  idempotencyKey?: string;
  idempotencyReleasedAt?: string;
  createdAt: string;
  status: 'pending' | 'acked' | 'expired';
  ackedAt?: string;
  expiredAt?: string;
}

interface DeviceDeliveryStream {
  deviceId: string;
  nextSeq: number;
  lastAckedSeq: number;
  deliveries: StoredRelayDelivery[];
}

interface RelayDeliveryState {
  version: 1;
  streams: DeviceDeliveryStream[];
}

export class RelayDeliveryStore {
  #file: string;
  #clock: Clock;
  #retentionMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: Clock; retentionMs?: number } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-deliveries.json');
    this.#clock = options.clock ?? (() => new Date());
    this.#retentionMs = boundedRetention(options.retentionMs);
  }

  async enqueue(deviceIdInput: string, kindInput: string, payloadInput: JsonObject, authorityInput?: RelayDeliveryAuthority, idempotencyKeyInput?: string, requiredCapabilitiesInput: readonly string[] = []): Promise<StoredRelayDelivery> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const kind = validKind(kindInput);
    const payload = safePayload(payloadInput);
    const authority = authorityInput === undefined ? undefined : safeAuthority(authorityInput, deviceId);
    const idempotencyKey = idempotencyKeyInput === undefined ? undefined : validIdempotencyKey(idempotencyKeyInput);
    const requiredCapabilities = safeRequiredCapabilities(requiredCapabilitiesInput);
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      if (idempotencyKey) {
        for (const existingStream of state.streams) {
          const existing = existingStream.deliveries.find((delivery) => delivery.idempotencyKey === idempotencyKey && !delivery.idempotencyReleasedAt);
          if (!existing) continue;
          if (existingStream.deviceId !== deviceId) throw new OperatorError('RELAY_IDEMPOTENCY_ROUTE_CHANGED', 'An unacknowledged action retry resolved to a different device.');
          if (existing.status === 'pending' && (existing.requiredCapabilities === undefined || !sameCapabilities(existing.requiredCapabilities, requiredCapabilities))) {
            throw new OperatorError('RELAY_IDEMPOTENCY_CAPABILITY_CHANGED', 'An unacknowledged action retry changed its durable capability requirements.');
          }
          return cloneDelivery(existing);
        }
      }
      const stream = getOrCreateStream(state, deviceId);
      if (stream.deliveries.length >= MAX_DELIVERIES_PER_STREAM) {
        throw new OperatorError('RELAY_QUEUE_LIMIT', `Device relay queue has reached ${MAX_DELIVERIES_PER_STREAM} retained deliveries.`);
      }
      const delivery: StoredRelayDelivery = {
        seq: stream.nextSeq,
        id: crypto.randomUUID(),
        kind,
        payload,
        requiredCapabilities,
        authority,
        idempotencyKey,
        createdAt: this.#clock().toISOString(),
        status: 'pending'
      };
      stream.nextSeq += 1;
      stream.deliveries.push(delivery);
      return cloneDelivery(delivery);
    });
  }

  async findIdempotent(idempotencyKeyInput: string): Promise<{ deviceId: string; delivery: StoredRelayDelivery } | null> {
    const idempotencyKey = validIdempotencyKey(idempotencyKeyInput);
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      let found: { deviceId: string; delivery: StoredRelayDelivery } | null = null;
      for (const stream of state.streams) {
        for (const delivery of stream.deliveries) {
          if (delivery.idempotencyKey !== idempotencyKey || delivery.idempotencyReleasedAt) continue;
          if (found) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay idempotency authority is duplicated across retained deliveries.');
          found = { deviceId: stream.deviceId, delivery: cloneDelivery(delivery) };
        }
      }
      return found;
    });
  }

  async retained(deviceIdInput: string, seqInput: number): Promise<StoredRelayDelivery | null> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      const delivery = state.streams.find((stream) => stream.deviceId === deviceId)?.deliveries.find((entry) => entry.seq === seq);
      return delivery ? cloneDelivery(delivery) : null;
    });
  }

  async pending(deviceIdInput: string, limitInput = 100): Promise<StoredRelayDelivery[]> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const limit = boundedLimit(limitInput);
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) return [];
      return stream.deliveries.filter((delivery) => delivery.seq > stream.lastAckedSeq && delivery.status === 'pending').slice(0, limit).map(cloneDelivery);
    });
  }

  async cursor(deviceIdInput: string): Promise<{ lastAckedSeq: number; highestEnqueuedSeq: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      return stream ? { lastAckedSeq: stream.lastAckedSeq, highestEnqueuedSeq: stream.nextSeq - 1 } : { lastAckedSeq: 0, highestEnqueuedSeq: 0 };
    });
  }

  async acknowledge(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<{ lastAckedSeq: number; duplicate: boolean }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    return await this.#mutate((state) => {
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) throw new OperatorError('RELAY_ACK_UNKNOWN_STREAM', 'Cannot acknowledge a delivery for an unknown device stream.');
      const delivery = stream.deliveries.find((candidate) => candidate.seq === seq);
      if (!delivery || delivery.id !== deliveryId) throw new OperatorError('RELAY_ACK_MISMATCH', 'Relay acknowledgement does not match the stored delivery sequence and ID.');
      if (seq <= stream.lastAckedSeq) {
        if (!['acked', 'expired'].includes(delivery.status)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Terminal cursor references a non-terminal retained delivery.');
        return { lastAckedSeq: stream.lastAckedSeq, duplicate: true };
      }
      if (seq !== stream.lastAckedSeq + 1) {
        throw new OperatorError('RELAY_ACK_GAP', `Expected acknowledgement for sequence ${stream.lastAckedSeq + 1} before sequence ${seq}.`);
      }
      delivery.status = 'acked';
      delivery.ackedAt = this.#clock().toISOString();
      delivery.payload = {};
      delivery.requiredCapabilities = undefined;
      delivery.authority = undefined;
      stream.lastAckedSeq = seq;
      return { lastAckedSeq: stream.lastAckedSeq, duplicate: false };
    });
  }

  async reconcileClientCursor(deviceIdInput: string, clientSeqInput: number): Promise<{ lastAckedSeq: number; advanced: number; expiredThroughSeq?: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const clientSeq = validNonNegativeSeq(clientSeqInput);
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) {
        if (clientSeq === 0) return { lastAckedSeq: 0, advanced: 0 };
        throw new OperatorError('RELAY_RESUME_AHEAD', 'Client resume cursor references deliveries the server has never enqueued.');
      }
      if (clientSeq < stream.lastAckedSeq) {
        const crossed = stream.deliveries.filter((delivery) => delivery.seq > clientSeq && delivery.seq <= stream.lastAckedSeq);
        if (crossed.length === stream.lastAckedSeq - clientSeq && crossed.every((delivery) => delivery.status === 'expired' && Object.keys(delivery.payload).length === 0 && delivery.authority === undefined)) {
          return { lastAckedSeq: stream.lastAckedSeq, advanced: stream.lastAckedSeq - clientSeq, expiredThroughSeq: stream.lastAckedSeq };
        }
        throw new OperatorError('RELAY_RESUME_BEHIND', 'Client resume cursor is behind executed relay history; automatic replay is unsafe.', {
          details: { clientSeq, serverSeq: stream.lastAckedSeq }
        });
      }
      const highest = stream.nextSeq - 1;
      if (clientSeq > highest) {
        throw new OperatorError('RELAY_RESUME_AHEAD', 'Client resume cursor is ahead of the highest server delivery.', {
          details: { clientSeq, highestEnqueuedSeq: highest }
        });
      }
      if (clientSeq === stream.lastAckedSeq) return { lastAckedSeq: stream.lastAckedSeq, advanced: 0 };

      const from = stream.lastAckedSeq + 1;
      for (let seq = from; seq <= clientSeq; seq += 1) {
        const delivery = stream.deliveries.find((candidate) => candidate.seq === seq);
        if (!delivery) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay queue is missing a delivery needed to reconcile the client cursor.');
        delivery.status = 'acked';
        delivery.ackedAt = this.#clock().toISOString();
        delivery.payload = {};
        delivery.requiredCapabilities = undefined;
        delivery.authority = undefined;
      }
      stream.lastAckedSeq = clientSeq;
      return { lastAckedSeq: clientSeq, advanced: clientSeq - from + 1 };
    });
  }

  async expireCapabilityIncompatibleHeads(deviceIdInput: string, supportedCapabilitiesInput: readonly string[]): Promise<number> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const supported = new Set(safeRequiredCapabilities([...supportedCapabilitiesInput]));
    return await this.#mutate((state) => {
      expirePending(state, this.#clock().getTime(), this.#retentionMs);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) return 0;
      let expired = 0;
      const expiredAt = this.#clock().toISOString();
      while (true) {
        const next = stream.deliveries.find((delivery) => delivery.seq === stream.lastAckedSeq + 1);
        if (!next || next.status !== 'pending') break;
        if (next.requiredCapabilities === undefined) throw new OperatorError('RELAY_DELIVERY_CAPABILITIES_MISSING', 'Pending relay delivery has no durable capability requirements.');
        if (next.requiredCapabilities.every((capability) => supported.has(capability))) break;
        expireDelivery(next, expiredAt);
        stream.lastAckedSeq = next.seq;
        expired += 1;
      }
      return expired;
    });
  }

  async expirePending(): Promise<number> {
    return await this.#mutate((state) => expirePending(state, this.#clock().getTime(), this.#retentionMs));
  }

  async purgeDevice(deviceIdInput: string): Promise<number> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    return await this.#mutate((state) => {
      const stream = state.streams.find((item) => item.deviceId === deviceId);
      if (!stream) return 0;
      const scrubbedAt = this.#clock().toISOString();
      const scrubbed = stream.deliveries.length;
      for (const delivery of stream.deliveries) {
        delivery.status = 'expired';
        delivery.expiredAt = scrubbedAt;
        delivery.ackedAt = undefined;
        delivery.payload = {};
        delivery.requiredCapabilities = undefined;
        delivery.authority = undefined;
        delivery.replayAuthority = undefined;
        delivery.idempotencyKey = undefined;
        delivery.idempotencyReleasedAt = undefined;
      }
      stream.lastAckedSeq = stream.nextSeq - 1;
      return scrubbed;
    });
  }

  async #read(): Promise<RelayDeliveryState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 128 * 1024 * 1024,
        errorCode: 'RELAY_QUEUE_CORRUPT',
        invalidMessage: 'Relay delivery state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, streams: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state could not be read.');
    }
  }

  async #write(stateInput: RelayDeliveryState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 128 * 1024 * 1024,
      errorCode: 'RELAY_QUEUE_CORRUPT',
      invalidMessage: 'Relay delivery state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: RelayDeliveryState) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const result = await mutator(state);
      await this.#write(state);
      return result;
    } finally {
      release();
    }
  }
}

function boundedRetention(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_MS;
  if (!Number.isFinite(value) || value < 60_000 || value > MAX_RETENTION_MS) {
    throw new OperatorError('RELAY_DELIVERY_RETENTION_INVALID', `Relay delivery retention must be between 60000 and ${MAX_RETENTION_MS} ms.`);
  }
  return Math.trunc(value);
}

function expirePending(state: RelayDeliveryState, now: number, retentionMs: number): number {
  let expired = 0;
  const expiredAt = new Date(now).toISOString();
  for (const stream of state.streams) {
    while (true) {
      const next = stream.deliveries.find((delivery) => delivery.seq === stream.lastAckedSeq + 1);
      if (!next || next.status !== 'pending' || Date.parse(next.createdAt) > now - retentionMs) break;
      expireDelivery(next, expiredAt);
      stream.lastAckedSeq = next.seq;
      expired += 1;
    }
    for (const delivery of stream.deliveries) {
      if (delivery.status === 'acked' && delivery.idempotencyKey && delivery.ackedAt && Date.parse(delivery.ackedAt) <= now - retentionMs) { delivery.idempotencyKey = undefined; delivery.idempotencyReleasedAt = undefined; }
    }
  }
  return expired;
}

function expireDelivery(delivery: StoredRelayDelivery, expiredAt: string): void {
  delivery.status = 'expired';
  delivery.expiredAt = expiredAt;
  delivery.ackedAt = undefined;
  delivery.payload = {};
  delivery.requiredCapabilities = undefined;
  delivery.replayAuthority = delivery.idempotencyKey && delivery.authority ? { ...delivery.authority } : undefined;
  delivery.authority = undefined;
  delivery.idempotencyReleasedAt = undefined;
}

function getOrCreateStream(state: RelayDeliveryState, deviceId: string): DeviceDeliveryStream {
  const existing = state.streams.find((stream) => stream.deviceId === deviceId);
  if (existing) return existing;
  if (state.streams.length >= MAX_STREAMS) throw new OperatorError('RELAY_STREAM_LIMIT', `At most ${MAX_STREAMS} device streams may be stored.`);
  const stream: DeviceDeliveryStream = { deviceId, nextSeq: 1, lastAckedSeq: 0, deliveries: [] };
  state.streams.push(stream);
  state.streams.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return stream;
}

function validateState(input: RelayDeliveryState): RelayDeliveryState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.streams) || input.streams.length > MAX_STREAMS) {
    throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state structure is invalid.');
  }
  const devices = new Set<string>();
  const streams = input.streams.map((raw) => {
    const deviceId = validUuid(raw.deviceId, 'stream deviceId');
    if (devices.has(deviceId)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state contains duplicate device streams.');
    devices.add(deviceId);
    const nextSeq = validPositiveSeq(raw.nextSeq);
    const lastAckedSeq = validNonNegativeSeq(raw.lastAckedSeq);
    if (lastAckedSeq >= nextSeq) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream acknowledgement cursor must be lower than next sequence.');
    if (!Array.isArray(raw.deliveries) || raw.deliveries.length > MAX_DELIVERIES_PER_STREAM) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream deliveries exceed the bounded limit.');
    const seenSeq = new Set<number>();
    const seenIds = new Set<string>();
    const deliveries = raw.deliveries.map((entry) => {
      const seq = validSeq(entry.seq);
      const id = validUuid(entry.id, 'deliveryId');
      if (seenSeq.has(seq) || seenIds.has(id)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream contains duplicate sequence or delivery ID.');
      seenSeq.add(seq); seenIds.add(id);
      if (seq >= nextSeq) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Retained delivery sequence must be lower than next sequence.');
      const kind = validKind(entry.kind);
      const payload = safePayload(entry.payload);
      const authority = entry.authority === undefined ? undefined : safeAuthority(entry.authority, deviceId);
      const replayAuthority = entry.replayAuthority === undefined ? undefined : safeAuthority(entry.replayAuthority, deviceId);
      const idempotencyKey = entry.idempotencyKey === undefined ? undefined : validIdempotencyKey(entry.idempotencyKey);
      const idempotencyReleasedAt = entry.idempotencyReleasedAt === undefined ? undefined : validIso(entry.idempotencyReleasedAt, 'idempotencyReleasedAt');
      if (idempotencyReleasedAt && !idempotencyKey) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Released idempotency authority is missing its key.');
      const createdAt = validIso(entry.createdAt, 'createdAt');
      const status = entry.status === 'pending' ? 'pending' : entry.status === 'acked' ? 'acked' : entry.status === 'expired' ? 'expired' : null;
      if (!status) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery status is invalid.');
      const requiredCapabilities = entry.requiredCapabilities === undefined
        ? legacyRequiredCapabilities(kind, payload, status, authority)
        : safeRequiredCapabilities(entry.requiredCapabilities);
      const ackedAt = entry.ackedAt === undefined ? undefined : validIso(entry.ackedAt, 'ackedAt');
      const expiredAt = entry.expiredAt === undefined ? undefined : validIso(entry.expiredAt, 'expiredAt');
      if (status === 'pending' && (ackedAt || expiredAt || replayAuthority)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Pending delivery cannot contain terminal timestamps or replay authority.');
      if (status === 'acked' && (!ackedAt || expiredAt || replayAuthority)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Acknowledged delivery must contain only an acknowledgement timestamp.');
      if (status === 'expired' && (!expiredAt || ackedAt || Object.keys(payload).length !== 0 || authority || idempotencyReleasedAt || (replayAuthority && !idempotencyKey))) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Expired delivery must be a payload-free live-authority-free tombstone.');
      if (seq <= lastAckedSeq && !['acked', 'expired'].includes(status)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery at/below the terminal cursor must be terminal.');
      if (seq > lastAckedSeq && status !== 'pending') throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery above the acknowledgement cursor must remain pending.');
      return { seq, id, kind, payload, requiredCapabilities, authority, replayAuthority, idempotencyKey, idempotencyReleasedAt, createdAt, status, ackedAt, expiredAt } satisfies StoredRelayDelivery;
    }).sort((a, b) => a.seq - b.seq);
    for (let seq = 1; seq < nextSeq; seq += 1) {
      if (!seenSeq.has(seq)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream contains a sequence gap.');
    }
    return { deviceId, nextSeq, lastAckedSeq, deliveries };
  });
  return { version: 1, streams };
}

function cloneDelivery(delivery: StoredRelayDelivery): StoredRelayDelivery {
  return {
    ...delivery,
    payload: structuredClone(delivery.payload),
    requiredCapabilities: delivery.requiredCapabilities ? [...delivery.requiredCapabilities] : undefined,
    authority: delivery.authority ? { ...delivery.authority } : undefined,
    replayAuthority: delivery.replayAuthority ? { ...delivery.replayAuthority } : undefined
  };
}

function safeRequiredCapabilities(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_REQUIRED_CAPABILITIES) {
    throw new OperatorError('RELAY_CAPABILITY_REQUIREMENTS_INVALID', `Relay capability requirements must be an array of at most ${MAX_REQUIRED_CAPABILITIES} entries.`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/*-]{0,127}$/.test(raw)) {
      throw new OperatorError('RELAY_CAPABILITY_REQUIREMENTS_INVALID', 'Relay capability requirement is invalid.');
    }
    if (!seen.has(raw)) { seen.add(raw); output.push(raw); }
  }
  return output.sort();
}

function legacyRequiredCapabilities(kind: string, payload: JsonObject, status: StoredRelayDelivery['status'], authority?: RelayDeliveryAuthority): string[] | undefined {
  if (status !== 'pending' || !authority || kind !== 'action') return undefined;
  const action = payload.action;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return undefined;
  const capability = (action as Record<string, unknown>).capability;
  return typeof capability === 'string' ? safeRequiredCapabilities([capability]) : undefined;
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeAuthority(input: unknown, expectedDeviceId: string): RelayDeliveryAuthority {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority is invalid.');
  const raw = input as Record<string, unknown>;
  const accountId = validUuid(String(raw.accountId ?? ''), 'authority accountId');
  const deviceId = validUuid(String(raw.deviceId ?? ''), 'authority deviceId');
  const generation = Number(raw.generation);
  if (deviceId !== expectedDeviceId) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority device does not match its stream.');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority generation is invalid.');
  return { accountId, deviceId, generation };
}

function safePayload(input: unknown): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_PAYLOAD_INVALID', 'Relay delivery payload must be a JSON object.');
  let text: string;
  try { text = JSON.stringify(input); } catch { throw new OperatorError('RELAY_PAYLOAD_INVALID', 'Relay delivery payload is not JSON serializable.'); }
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) throw new OperatorError('RELAY_PAYLOAD_TOO_LARGE', `Relay delivery payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new OperatorError('RELAY_PAYLOAD_INVALID', 'Relay delivery payload is invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OperatorError('RELAY_PAYLOAD_INVALID', 'Relay delivery payload must remain an object after serialization.');
  return parsed as JsonObject;
}

function validKind(value: string): string {
  const kind = String(value ?? '');
  if (!kind || kind.length > MAX_KIND || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(kind)) throw new OperatorError('RELAY_KIND_INVALID', 'Relay delivery kind is invalid.');
  return kind;
}

function validIdempotencyKey(value: string): string {
  const key = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  return key;
}

function boundedLimit(value: number): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PENDING_RETURN) throw new OperatorError('RELAY_LIMIT_INVALID', `Relay delivery limit must be between 1 and ${MAX_PENDING_RETURN}.`);
  return limit;
}

function validSeq(value: number): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a positive safe integer.');
  return seq;
}
function validPositiveSeq(value: number): number { return validSeq(value); }
function validNonNegativeSeq(value: number): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a non-negative safe integer.');
  return seq;
}

function validUuid(value: string, label: string): string {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new OperatorError('RELAY_ID_INVALID', `${label} must be a UUID.`);
  return text.toLowerCase();
}

function validIso(value: string, label: string): string {
  const text = String(value ?? '');
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw new OperatorError('RELAY_QUEUE_CORRUPT', `${label} must be an ISO timestamp.`);
  return text;
}
