import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { canonicalJson } from './action-identity.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { ControlPlaneStore } from './control-plane-store.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_STREAMS = 10_000;
const MAX_DELIVERIES_PER_STREAM = 10_000;
const DEFAULT_TERMINAL_REPLAY_WINDOW = 256;
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
  /** Privacy-bounded binding retained after terminal payload scrubbing. */
  idempotencyContractDigest?: string;
  idempotencyReleasedAt?: string;
  createdAt: string;
  status: 'pending' | 'acked' | 'expired';
  ackedAt?: string;
  expiredAt?: string;
}

interface DeviceDeliveryStream {
  deviceId: string;
  /** First sequence still represented by a retained delivery record. */
  baseSeq: number;
  nextSeq: number;
  lastAckedSeq: number;
  /** Highest compacted sequence that represented an executed/ACKed delivery. */
  highestCompactedAckedSeq: number;
  deliveries: StoredRelayDelivery[];
}

interface RelayDeliveryState {
  version: 2;
  streams: DeviceDeliveryStream[];
}

export class RelayDeliveryStore {
  #file: string;
  #clock: Clock;
  #retentionMs: number;
  #maxDeliveriesPerStream: number;
  #terminalReplayWindow: number;
  #queue: Promise<void> = Promise.resolve();
  #shared?: ControlPlaneStore;
  #sharedNamespace: string;

  constructor(stateDir: string, options: {
    clock?: Clock;
    retentionMs?: number;
    maxDeliveriesPerStream?: number;
    terminalReplayWindow?: number;
    sharedStore?: ControlPlaneStore;
    sharedNamespace?: string;
  } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'relay-deliveries.json');
    this.#clock = options.clock ?? (() => new Date());
    this.#retentionMs = boundedRetention(options.retentionMs);
    this.#maxDeliveriesPerStream = boundedMaxDeliveries(options.maxDeliveriesPerStream);
    this.#terminalReplayWindow = boundedReplayWindow(options.terminalReplayWindow, this.#maxDeliveriesPerStream);
    this.#shared = options.sharedStore;
    this.#sharedNamespace = validSharedNamespace(options.sharedNamespace ?? 'relay-delivery-streams');
  }

  async enqueue(deviceIdInput: string, kindInput: string, payloadInput: JsonObject, authorityInput?: RelayDeliveryAuthority, idempotencyKeyInput?: string, requiredCapabilitiesInput: readonly string[] = []): Promise<StoredRelayDelivery> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const kind = validKind(kindInput);
    const payload = safePayload(payloadInput);
    const authority = authorityInput === undefined ? undefined : safeAuthority(authorityInput, deviceId);
    const idempotencyKey = idempotencyKeyInput === undefined ? undefined : validIdempotencyKey(idempotencyKeyInput);
    const requiredCapabilities = safeRequiredCapabilities(requiredCapabilitiesInput);
    const contractDigest = idempotencyKey
      ? relayIdempotencyContractDigest(kind, payload, authority, requiredCapabilities)
      : undefined;
    return await this.#mutate((state) => {
      this.#maintain(state);
      if (idempotencyKey) {
        for (const existingStream of state.streams) {
          const existing = existingStream.deliveries.find((delivery) => delivery.idempotencyKey === idempotencyKey && !delivery.idempotencyReleasedAt);
          if (!existing) continue;
          if (existingStream.deviceId !== deviceId) throw new OperatorError('RELAY_IDEMPOTENCY_ROUTE_CHANGED', 'An unacknowledged action retry resolved to a different device.');
          if (existing.status !== 'pending') {
            // ACK/expiry erase the input and its authority. A retained
            // contract digest is the only safe way to identify the original
            // invocation without rehydrating sensitive terminal payload.
            if (!existing.idempotencyContractDigest) {
              throw new OperatorError('RELAY_IDEMPOTENCY_CONTRACT_UNVERIFIABLE', 'Legacy terminal replay cannot prove the original request contract.');
            }
            if (existing.idempotencyContractDigest !== contractDigest) {
              throw new OperatorError('RELAY_IDEMPOTENCY_CONTRACT_CHANGED', 'Terminal idempotency replay changed the original payload, authority or capabilities.');
            }
          }
          if (existing.status === 'pending') {
            if (existing.requiredCapabilities === undefined || !sameCapabilities(existing.requiredCapabilities, requiredCapabilities)) {
              throw new OperatorError('RELAY_IDEMPOTENCY_CAPABILITY_CHANGED', 'An unacknowledged action retry changed its durable capability requirements.');
            }
            if (existing.kind !== kind || canonicalJson(existing.payload) !== canonicalJson(payload)) {
              throw new OperatorError('RELAY_IDEMPOTENCY_INPUT_CHANGED', 'An unacknowledged action retry changed its durable operation identity.');
            }
            if (!sameAuthority(existing.authority, authority)) {
              throw new OperatorError('RELAY_IDEMPOTENCY_AUTHORITY_CHANGED', 'An unacknowledged action retry changed its account-device authority.');
            }
            if (existing.idempotencyContractDigest && existing.idempotencyContractDigest !== contractDigest) {
              throw new OperatorError('RELAY_IDEMPOTENCY_CONTRACT_CHANGED', 'Retained pending invocation contract digest differs.');
            }
            // A legitimate retry is an authenticated chance to upgrade
            // pre-digest pending records before the payload is erased.
            if (!existing.idempotencyContractDigest) existing.idempotencyContractDigest = contractDigest;
          }
          return cloneDelivery(existing);
        }
      }
      const stream = getOrCreateStream(state, deviceId);
      if (stream.deliveries.length >= this.#maxDeliveriesPerStream) {
        throw new OperatorError('RELAY_QUEUE_LIMIT', `Device relay queue has reached ${this.#maxDeliveriesPerStream} live/replay-window deliveries.`);
      }
      const delivery: StoredRelayDelivery = {
        seq: stream.nextSeq,
        id: crypto.randomUUID(),
        kind,
        payload,
        requiredCapabilities,
        authority,
        idempotencyKey,
        idempotencyContractDigest: contractDigest,
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
      this.#maintain(state);
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
      this.#maintain(state);
      const delivery = state.streams.find((stream) => stream.deviceId === deviceId)?.deliveries.find((entry) => entry.seq === seq);
      return delivery ? cloneDelivery(delivery) : null;
    });
  }

  async pending(deviceIdInput: string, limitInput = 100): Promise<StoredRelayDelivery[]> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const limit = boundedLimit(limitInput);
    return await this.#mutate((state) => {
      this.#maintain(state);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) return [];
      return stream.deliveries.filter((delivery) => delivery.seq > stream.lastAckedSeq && delivery.status === 'pending').slice(0, limit).map(cloneDelivery);
    });
  }

  async cursor(deviceIdInput: string): Promise<{ lastAckedSeq: number; highestEnqueuedSeq: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    return await this.#mutate((state) => {
      this.#maintain(state);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      return stream ? { lastAckedSeq: stream.lastAckedSeq, highestEnqueuedSeq: stream.nextSeq - 1 } : { lastAckedSeq: 0, highestEnqueuedSeq: 0 };
    });
  }

  async acknowledge(deviceIdInput: string, seqInput: number, deliveryIdInput: string): Promise<{ lastAckedSeq: number; duplicate: boolean }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const seq = validSeq(seqInput);
    const deliveryId = validUuid(deliveryIdInput, 'deliveryId');
    return await this.#mutate((state) => {
      this.#maintain(state);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) throw new OperatorError('RELAY_ACK_UNKNOWN_STREAM', 'Cannot acknowledge a delivery for an unknown device stream.');
      if (seq < stream.baseSeq) {
        throw new OperatorError('RELAY_ACK_COMPACTED', 'Relay acknowledgement is older than the bounded replay tombstone window.', {
          details: { seq, baseSeq: stream.baseSeq, lastAckedSeq: stream.lastAckedSeq }
        });
      }
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
      compactStream(stream, this.#terminalReplayWindow);
      return { lastAckedSeq: stream.lastAckedSeq, duplicate: false };
    });
  }

  async reconcileClientCursor(deviceIdInput: string, clientSeqInput: number): Promise<{ lastAckedSeq: number; advanced: number; expiredThroughSeq?: number }> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const clientSeq = validNonNegativeSeq(clientSeqInput);
    return await this.#mutate((state) => {
      this.#maintain(state);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream) {
        if (clientSeq === 0) return { lastAckedSeq: 0, advanced: 0 };
        throw new OperatorError('RELAY_RESUME_AHEAD', 'Client resume cursor references deliveries the server has never enqueued.');
      }
      if (clientSeq < stream.lastAckedSeq) {
        const retainedFrom = Math.max(clientSeq + 1, stream.baseSeq);
        const crossed = stream.deliveries.filter((delivery) => delivery.seq >= retainedFrom && delivery.seq <= stream.lastAckedSeq);
        const expectedRetained = Math.max(0, stream.lastAckedSeq - retainedFrom + 1);
        const compactedCrossingContainsAck = stream.highestCompactedAckedSeq > clientSeq;
        if (!compactedCrossingContainsAck
          && crossed.length === expectedRetained
          && crossed.every((delivery) => delivery.status === 'expired' && Object.keys(delivery.payload).length === 0 && delivery.authority === undefined)) {
          return { lastAckedSeq: stream.lastAckedSeq, advanced: stream.lastAckedSeq - clientSeq, expiredThroughSeq: stream.lastAckedSeq };
        }
        throw new OperatorError('RELAY_RESUME_BEHIND', 'Client resume cursor is behind executed relay history; automatic replay is unsafe.', {
          details: { clientSeq, serverSeq: stream.lastAckedSeq, baseSeq: stream.baseSeq, highestCompactedAckedSeq: stream.highestCompactedAckedSeq }
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
      compactStream(stream, this.#terminalReplayWindow);
      return { lastAckedSeq: clientSeq, advanced: clientSeq - from + 1 };
    });
  }

  async expireUnroutableHeads(
    deviceIdInput: string,
    supportedCapabilitiesInput: readonly string[],
    canCommit: () => boolean = () => true
  ): Promise<number> {
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    const supported = new Set(safeRequiredCapabilities([...supportedCapabilitiesInput]));
    return await this.#mutate((state) => {
      this.#maintain(state);
      const stream = state.streams.find((candidate) => candidate.deviceId === deviceId);
      if (!stream || !canCommit()) return 0;
      let expired = 0;
      const expiredAt = this.#clock().toISOString();
      while (true) {
        const next = stream.deliveries.find((delivery) => delivery.seq === stream.lastAckedSeq + 1);
        if (!next || next.status !== 'pending') break;
        const routable = next.authority !== undefined
          && next.requiredCapabilities !== undefined
          && next.requiredCapabilities.every((capability) => supported.has(capability));
        if (routable) break;
        expireDelivery(next, expiredAt);
        stream.lastAckedSeq = next.seq;
        expired += 1;
      }
      compactStream(stream, this.#terminalReplayWindow);
      return expired;
    });
  }

  async expirePending(): Promise<number> {
    return await this.#mutate((state) => this.#maintain(state));
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
        delivery.idempotencyContractDigest = undefined;
        delivery.idempotencyReleasedAt = undefined;
      }
      stream.lastAckedSeq = stream.nextSeq - 1;
      compactStream(stream, this.#terminalReplayWindow);
      return scrubbed;
    });
  }

  #maintain(state: RelayDeliveryState): number {
    const expired = expirePending(state, this.#clock().getTime(), this.#retentionMs);
    compactStreams(state, this.#terminalReplayWindow);
    return expired;
  }

  async #read(): Promise<RelayDeliveryState> {
    if (this.#shared) return (await this.#readShared()).state;
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 128 * 1024 * 1024,
        errorCode: 'RELAY_QUEUE_CORRUPT',
        invalidMessage: 'Relay delivery state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, streams: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state could not be read.');
    }
  }

  async #write(stateInput: RelayDeliveryState): Promise<void> {
    if (this.#shared) throw new OperatorError('RELAY_QUEUE_SHARED_WRITE_INVALID', 'Shared relay state must commit through compare-and-swap mutation.');
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 128 * 1024 * 1024,
      errorCode: 'RELAY_QUEUE_CORRUPT',
      invalidMessage: 'Relay delivery state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: RelayDeliveryState) => T | Promise<T>): Promise<T> {
    if (this.#shared) return await this.#mutateShared(mutator);
    let release!: () => void;
    const previous = this.#queue;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await withDurableStateLock(this.#file, async () => {
        const state = await this.#read();
        const result = await mutator(state);
        await this.#write(state);
        return result;
      });
    } finally {
      release();
    }
  }

  async #readShared(): Promise<{
    state: RelayDeliveryState;
    generations: Map<string, number>;
    epochGeneration: number | null;
    epochCounter: number;
  }> {
    const records = await this.#shared!.list(this.#sharedNamespace);
    const streams: DeviceDeliveryStream[] = [];
    const generations = new Map<string, number>();
    let epochGeneration: number | null = null;
    let epochCounter = 0;
    for (const record of records) {
      if (record.key === '__epoch') {
        epochGeneration = record.generation;
        const counter = record.value.counter;
        // A persisted epoch is a typed monotonic counter; never normalize missing or coerced values.
        if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Shared relay delivery epoch is invalid.');
        epochCounter = counter;
        continue;
      }
      const stream = record.value.stream;
      // A shared CAS key is the authenticated storage identity for exactly one device.
      // Never let persisted data relabel a stream as another device or downgrade its schema.
      if (record.value.stateVersion !== 2 || !stream || typeof stream !== 'object' || Array.isArray(stream) ||
          (stream as Record<string, unknown>).deviceId !== record.key) {
        throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Shared relay delivery stream schema or device key is invalid.');
      }
      streams.push(structuredClone(stream) as DeviceDeliveryStream);
      generations.set(record.key, record.generation);
    }
    return {
      state: validateState({ version: 2, streams }),
      generations,
      epochGeneration,
      epochCounter
    };
  }

  async #mutateShared<T>(mutator: (state: RelayDeliveryState) => T | Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const snapshot = await this.#readShared();
      const before = new Map(snapshot.state.streams.map((stream) => [stream.deviceId, JSON.stringify(stream)]));
      const value = await mutator(snapshot.state);
      const normalized = validateState(snapshot.state);
      const after = new Map(normalized.streams.map((stream) => [stream.deviceId, stream]));
      const keys = new Set([...before.keys(), ...after.keys()]);
      const mutations = [];
      for (const key of [...keys].sort()) {
        const prior = before.get(key);
        const next = after.get(key);
        if (prior !== undefined && next !== undefined && prior === JSON.stringify(next)) continue;
        if (next === undefined) {
          const generation = snapshot.generations.get(key);
          if (generation === undefined) continue;
          mutations.push({ namespace: this.#sharedNamespace, key, expectedGeneration: generation, value: null });
          continue;
        }
        const generation = snapshot.generations.get(key);
        mutations.push({
          namespace: this.#sharedNamespace,
          key,
          expectedGeneration: generation ?? null,
          value: { stateVersion: 2, stream: structuredClone(next) }
        });
      }
      if (mutations.length === 0) return value;
      mutations.push({
        namespace: this.#sharedNamespace,
        key: '__epoch',
        expectedGeneration: snapshot.epochGeneration,
        value: { counter: snapshot.epochCounter + 1 }
      });
      try {
        await this.#shared!.transact(mutations, this.#clock().toISOString());
        return value;
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'CONTROL_PLANE_CAS_MISMATCH') continue;
        throw error;
      }
    }
    throw new OperatorError('RELAY_QUEUE_CONTENTION', 'Shared relay delivery state remained contended after bounded retries.', { retryable: true });
  }
}

function validSharedNamespace(value: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(text) || text === '__epoch') {
    throw new OperatorError('RELAY_QUEUE_SHARED_NAMESPACE_INVALID', 'Shared relay delivery namespace is invalid.');
  }
  return text;
}

function boundedMaxDeliveries(value: number | undefined): number {
  if (value === undefined) return MAX_DELIVERIES_PER_STREAM;
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_DELIVERIES_PER_STREAM) {
    throw new OperatorError('RELAY_DELIVERY_LIMIT_INVALID', `Relay maxDeliveriesPerStream must be between 2 and ${MAX_DELIVERIES_PER_STREAM}.`);
  }
  return value;
}

function boundedReplayWindow(value: number | undefined, maxDeliveries: number): number {
  const fallback = Math.min(DEFAULT_TERMINAL_REPLAY_WINDOW, Math.max(1, maxDeliveries - 1));
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value >= maxDeliveries) {
    throw new OperatorError('RELAY_REPLAY_WINDOW_INVALID', 'Relay terminalReplayWindow must be at least 1 and smaller than maxDeliveriesPerStream.');
  }
  return value;
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
      if (!delivery.idempotencyKey) continue;
      const terminalAt = delivery.status === 'acked' ? delivery.ackedAt : delivery.status === 'expired' ? delivery.expiredAt : undefined;
      if (!terminalAt || Date.parse(terminalAt) > now - retentionMs) continue;
      delivery.idempotencyKey = undefined;
      delivery.idempotencyContractDigest = undefined;
      delivery.idempotencyReleasedAt = undefined;
      delivery.replayAuthority = undefined;
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

function compactStreams(state: RelayDeliveryState, replayWindow: number): number {
  let compacted = 0;
  for (const stream of state.streams) compacted += compactStream(stream, replayWindow);
  return compacted;
}

function compactStream(stream: DeviceDeliveryStream, replayWindow: number): number {
  let terminalCount = 0;
  for (const delivery of stream.deliveries) {
    if (delivery.seq > stream.lastAckedSeq) break;
    terminalCount += 1;
  }
  let removable = Math.max(0, terminalCount - replayWindow);
  let compacted = 0;
  while (removable > 0) {
    const delivery = stream.deliveries[0];
    if (!delivery || delivery.seq !== stream.baseSeq || delivery.seq > stream.lastAckedSeq || delivery.status === 'pending') break;
    if (delivery.idempotencyKey || delivery.replayAuthority) break;
    if (delivery.status === 'acked') stream.highestCompactedAckedSeq = Math.max(stream.highestCompactedAckedSeq, delivery.seq);
    stream.deliveries.shift();
    stream.baseSeq = delivery.seq + 1;
    removable -= 1;
    compacted += 1;
  }
  if (stream.deliveries.length === 0) stream.baseSeq = stream.nextSeq;
  return compacted;
}

function getOrCreateStream(state: RelayDeliveryState, deviceId: string): DeviceDeliveryStream {
  const existing = state.streams.find((stream) => stream.deviceId === deviceId);
  if (existing) return existing;
  if (state.streams.length >= MAX_STREAMS) throw new OperatorError('RELAY_STREAM_LIMIT', `At most ${MAX_STREAMS} device streams may be stored.`);
  const stream: DeviceDeliveryStream = { deviceId, baseSeq: 1, nextSeq: 1, lastAckedSeq: 0, highestCompactedAckedSeq: 0, deliveries: [] };
  state.streams.push(stream);
  state.streams.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return stream;
}

function validateState(input: unknown): RelayDeliveryState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state structure is invalid.');
  }
  const rawState = input as Record<string, unknown>;
  // Persisted schema versions are exact JSON numbers, never coerced legacy markers.
  const version = rawState.version;
  if ((version !== 1 && version !== 2) || !Array.isArray(rawState.streams) || rawState.streams.length > MAX_STREAMS) {
    throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state structure is invalid.');
  }
  const devices = new Set<string>();
  const streams = rawState.streams.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay device stream is invalid.');
    const raw = entry as Record<string, any>;
    const deviceId = validUuid(raw.deviceId, 'stream deviceId');
    if (devices.has(deviceId)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery state contains duplicate device streams.');
    devices.add(deviceId);
    const nextSeq = validPositiveSeq(raw.nextSeq);
    const lastAckedSeq = validNonNegativeSeq(raw.lastAckedSeq);
    const baseSeq = version === 1 ? 1 : validPositiveSeq(raw.baseSeq);
    const highestCompactedAckedSeq = version === 1 ? 0 : validNonNegativeSeq(raw.highestCompactedAckedSeq);
    if (lastAckedSeq >= nextSeq) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream acknowledgement cursor must be lower than next sequence.');
    if (baseSeq > nextSeq || lastAckedSeq < baseSeq - 1) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay compacted prefix is inconsistent with its acknowledgement cursor.');
    if (highestCompactedAckedSeq >= baseSeq || highestCompactedAckedSeq > lastAckedSeq) {
      throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay compacted ACK watermark is outside the compacted terminal prefix.');
    }
    if (!Array.isArray(raw.deliveries) || raw.deliveries.length > MAX_DELIVERIES_PER_STREAM) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream deliveries exceed the bounded limit.');
    const seenSeq = new Set<number>();
    const seenIds = new Set<string>();
    const deliveries = raw.deliveries.map((entry) => {
      const seq = validSeq(entry.seq);
      const id = validUuid(entry.id, 'deliveryId');
      if (seenSeq.has(seq) || seenIds.has(id)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay stream contains duplicate sequence or delivery ID.');
      seenSeq.add(seq); seenIds.add(id);
      if (seq < baseSeq || seq >= nextSeq) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Retained delivery sequence must fall inside the retained stream window.');
      const kind = validKind(entry.kind);
      const payload = safePayload(entry.payload);
      const authority = entry.authority === undefined ? undefined : safeAuthority(entry.authority, deviceId);
      const replayAuthority = entry.replayAuthority === undefined ? undefined : safeAuthority(entry.replayAuthority, deviceId);
      const idempotencyKey = entry.idempotencyKey === undefined ? undefined : validIdempotencyKey(entry.idempotencyKey);
      const idempotencyContractDigest = entry.idempotencyContractDigest === undefined ? undefined : validIdempotencyContractDigest(entry.idempotencyContractDigest);
      if (idempotencyContractDigest && !idempotencyKey) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Invocation contract digest must have a retained key.');
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
      if (status === 'pending' && idempotencyContractDigest &&
        (requiredCapabilities === undefined ||
          idempotencyContractDigest !== relayIdempotencyContractDigest(kind, payload, authority, requiredCapabilities))) {
        throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Pending invocation contract digest does not match its live payload and authority.');
      }
      if (status === 'pending' && (ackedAt || expiredAt || replayAuthority)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Pending delivery cannot contain terminal timestamps or replay authority.');
      if (status === 'acked' && (!ackedAt || expiredAt || replayAuthority)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Acknowledged delivery must contain only an acknowledgement timestamp.');
      if (status === 'expired' && (!expiredAt || ackedAt || Object.keys(payload).length !== 0 || authority || idempotencyReleasedAt || (replayAuthority && !idempotencyKey))) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Expired delivery must be a payload-free live-authority-free tombstone.');
      if (seq <= lastAckedSeq && !['acked', 'expired'].includes(status)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery at/below the terminal cursor must be terminal.');
      if (seq > lastAckedSeq && status !== 'pending') throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Delivery above the acknowledgement cursor must remain pending.');
      return { seq, id, kind, payload, requiredCapabilities, authority, replayAuthority, idempotencyKey, idempotencyContractDigest, idempotencyReleasedAt, createdAt, status, ackedAt, expiredAt } satisfies StoredRelayDelivery;
    }).sort((a, b) => a.seq - b.seq);
    for (let seq = baseSeq; seq < nextSeq; seq += 1) {
      if (!seenSeq.has(seq)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay retained stream contains a sequence gap.');
    }
    if ((deliveries.length === 0 && baseSeq !== nextSeq) || (deliveries.length > 0 && deliveries[0]!.seq !== baseSeq)) {
      throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay retained stream does not begin at baseSeq.');
    }
    return { deviceId, baseSeq, nextSeq, lastAckedSeq, highestCompactedAckedSeq, deliveries };
  });
  return { version: 2, streams };
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

/**
 * Only the bounded digest survives terminal ACK/expiry. Do not retain the
 * original payload, capability list, or private account authority in tombstones.
 */
function relayIdempotencyContractDigest(
  kind: string, payload: JsonObject, authority: RelayDeliveryAuthority | undefined,
  requiredCapabilities: readonly string[]
): string {
  return crypto.createHash('sha256')
    .update('mecord-relay-idempotency-v1\0')
    .update(canonicalJson({ kind, payload, authority: authority ?? null, requiredCapabilities }))
    .digest('hex');
}

function validIdempotencyContractDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Retained idempotency contract digest is invalid.');
  }
  return value;
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

function sameAuthority(left: RelayDeliveryAuthority | undefined, right: RelayDeliveryAuthority | undefined): boolean {
  if (!left || !right) return left === right;
  return left.accountId === right.accountId && left.deviceId === right.deviceId && left.generation === right.generation;
}

function safeAuthority(input: unknown, expectedDeviceId: string): RelayDeliveryAuthority {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority is invalid.');
  const raw = input as Record<string, unknown>;
  const accountId = validUuid(raw.accountId, 'authority accountId');
  const deviceId = validUuid(raw.deviceId, 'authority deviceId');
  // Queue recovery cannot coerce a string or boolean into a valid authority.
  const generation = raw.generation;
  if (deviceId !== expectedDeviceId) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority device does not match its stream.');
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw new OperatorError('RELAY_QUEUE_CORRUPT', 'Relay delivery authority generation is invalid.');
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

function validKind(value: unknown): string {
  if (typeof value !== 'string') throw new OperatorError('RELAY_KIND_INVALID', 'Relay delivery kind is invalid.');
  const kind = value;
  if (!kind || kind.length > MAX_KIND || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(kind)) throw new OperatorError('RELAY_KIND_INVALID', 'Relay delivery kind is invalid.');
  return kind;
}

function validIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  const key = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new OperatorError('RELAY_IDEMPOTENCY_INVALID', 'Relay idempotency key is invalid.');
  return key;
}

function boundedLimit(value: unknown): number {
  if (typeof value !== 'number') throw new OperatorError('RELAY_LIMIT_INVALID', 'Relay delivery limit must be numeric.');
  const limit = value;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PENDING_RETURN) throw new OperatorError('RELAY_LIMIT_INVALID', `Relay delivery limit must be between 1 and ${MAX_PENDING_RETURN}.`);
  return limit;
}

function validSeq(value: unknown): number {
  if (typeof value !== 'number') throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a positive safe integer.');
  const seq = value;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a positive safe integer.');
  return seq;
}
function validPositiveSeq(value: number): number { return validSeq(value); }
function validNonNegativeSeq(value: unknown): number {
  if (typeof value !== 'number') throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a non-negative safe integer.');
  const seq = value;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new OperatorError('RELAY_SEQUENCE_INVALID', 'Relay sequence must be a non-negative safe integer.');
  return seq;
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new OperatorError('RELAY_ID_INVALID', `${label} must be a UUID.`);
  const text = value;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new OperatorError('RELAY_ID_INVALID', `${label} must be a UUID.`);
  return text.toLowerCase();
}

function validIso(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new OperatorError('RELAY_QUEUE_CORRUPT', `${label} must be an ISO timestamp.`);
  const text = value;
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw new OperatorError('RELAY_QUEUE_CORRUPT', `${label} must be an ISO timestamp.`);
  return text;
}
