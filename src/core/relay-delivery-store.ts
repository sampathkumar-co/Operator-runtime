import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_STREAMS = 10_000;
const MAX_DELIVERIES_PER_STREAM = 10_000;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_KIND = 128;
const MAX_PENDING_RETURN = 500;

type Clock = () => Date;
type JsonObject = Record<string, unknown>;

export interface StoredRelayDelivery {
  seq: number;
  id: string;
  kind: string;
  payload: JsonObject;
  createdAt: string;
  status: 'pending' | 'acked';
  ackedAt?: string;
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
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-deliveries.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async enqueue(deviceIdInput: string, kindInput: string, payloadInput: JsonObject): Promise<StoredRelayDelivery> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const kind = validKind(kindInput);
    const payload = safePayload(payloadInput);
    return await this.#mutate((state) => {
      const stream = getOrCreateStream(state, deviceId);
      if (stream.deliveries.length >= MAX_DELIVERIES_PER_STREAM) {
        throw new OperatorError('RELAY_QUEUE_LIMIT', `Device relay queue has reached ${MAX_DELIVERIES_PER_STREAM} retained deliveries.`);
      }
      const delivery: StoredRelayDelivery = {
        seq: stream.nextSeq,
        id: crypto.randomUUID(),
        kind,
        payload,
        createdAt: this.#clock().toISOString(),
        status: 'pending'
      };
      stream.nextSeq += 1;
      stream.deliveries.push(delivery);
      return cloneDelivery(delivery);
    });
  }

  async pending(deviceIdInput: string, limitInput = 100): Promise<StoredRelayDelivery[]> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const limit = boundedLimit(limitInput);
    const state = await this.#read();
    const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
    if (!stream) return [];
    return stream.deliveries.filter((delivery) => delivery.seq > stream.lastAckedSeq && delivery.status === 'pending').slice(0, limit).map(cloneDelivery);
  }

  async cursor(deviceIdInput: string): Promise<{ lastAckedSeq: number; highestEnqueuedSeq: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const state = await this.#read();
    const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
    return stream ? { lastAckedSeq: stream.lastAckedSeq, highestEnqueuedSeq: stream.nextSeq - 1 } : { lastAckedSeq: 0, highestEnqueuedSeq: 0 };
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
        if (delivery.status !== 'acked') throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Acknowledged cursor references a non-acked retained delivery.');
        return { lastAckedSeq: stream.lastAckedSeq, duplicate: true };
      }
      if (seq !== stream.lastAckedSeq + 1) {
        throw new OperatorError('RELAY_ACK_GAP', `Expected acknowledgement for sequence ${stream.lastAckedSeq + 1} before sequence ${seq}.`);
      }
      delivery.status = 'acked';
      delivery.ackedAt = this.#clock().toISOString();
      stream.lastAckedSeq = seq;
      return { lastAckedSeq: stream.lastAckedSeq, duplicate: false };
    });
  }

  async reconcileClientCursor(deviceIdInput: string, clientSeqInput: number): Promise<{ lastAckedSeq: number; advanced: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const clientSeq = validNonNegativeSeq(clientSeqInput);
    return await this.#mutate((state) => {
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) {
        if (clientSeq === 0) return { lastAckedSeq: 0, advanced: 0 };
        throw new OperatorError('RELAY_RESUME_AHEAD', 'Client resume cursor references deliveries the server has never enqueued.');
      }
      if (clientSeq < stream.lastAckedSeq) {
        throw new OperatorError('RELAY_RESUME_BEHIND', 'Client resume cursor is behind the durable server acknowledgement cursor; automatic replay is unsafe.', {
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
      }
      stream.lastAckedSeq = clientSeq;
      return { lastAckedSeq: clientSeq, advanced: clientSeq - from + 1 };
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
      const createdAt = validIso(entry.createdAt, 'createdAt');
      const status = entry.status === 'pending' ? 'pending' : entry.status === 'acked' ? 'acked' : null;
      if (!status) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery status is invalid.');
      const ackedAt = entry.ackedAt === undefined ? undefined : validIso(entry.ackedAt, 'ackedAt');
      if (status === 'pending' && ackedAt) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Pending delivery cannot contain an acknowledgement timestamp.');
      if (seq <= lastAckedSeq && status !== 'acked') throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery at/below the acknowledgement cursor must be acked.');
      if (seq > lastAckedSeq && status !== 'pending') throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery above the acknowledgement cursor must remain pending.');
      return { seq, id, kind, payload, createdAt, status, ackedAt } satisfies StoredRelayDelivery;
    }).sort((a, b) => a.seq - b.seq);
    for (let seq = 1; seq < nextSeq; seq += 1) {
      if (!seenSeq.has(seq)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream contains a sequence gap.');
    }
    return { deviceId, nextSeq, lastAckedSeq, deliveries };
  });
  return { version: 1, streams };
}

function cloneDelivery(delivery: StoredRelayDelivery): StoredRelayDelivery {
  return { ...delivery, payload: structuredClone(delivery.payload) };
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
