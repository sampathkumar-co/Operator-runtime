import crypto from 'node:crypto';
import path from 'node:path';
import { DeviceRegistryStore } from './device-registry.ts';
import { DeviceRoutingStore } from './device-routing.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_RESERVATIONS = 5000;
const MAX_ADVERTISEMENTS = 1000;
const MAX_CAPABILITIES = 256;
const MAX_TAGS = 64;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 30 * 60_000;
const MAX_LIVENESS_MS = 5 * 60_000;
const STORE_OPTIONS = {
  maxBytes: 4 * 1024 * 1024,
  errorCode: 'DEVICE_POOL_STATE_CORRUPT',
  invalidMessage: 'Device pool state is invalid.'
} as const;

export interface DeviceResourceAdvertisement {
  deviceId: string;
  sessionId: string;
  capabilities: string[];
  observedAt: string;
  cpuSlots: number;
  memoryMb: number;
  gpu: boolean;
  tags: string[];
  activeJobs: number;
  maxConcurrentJobs: number;
}

export interface DeviceReservation {
  id: string;
  workloadKey: string;
  projectKey?: string;
  deviceId: string;
  sessionId: string;
  requiredCapabilities: string[];
  requiredTags: string[];
  minMemoryMb: number;
  requireGpu: boolean;
  slots: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
}

interface DevicePoolState {
  version: 1;
  reservations: DeviceReservation[];
}

export interface DevicePoolRequest {
  workloadKey: string;
  projectKey?: string;
  explicitDeviceId?: string;
  requiredCapabilities?: string[];
  requiredTags?: string[];
  minMemoryMb?: number;
  requireGpu?: boolean;
  slots?: number;
  leaseMs?: number;
  livenessMs?: number;
}

export class DevicePoolScheduler {
  #file: string;
  #registry: DeviceRegistryStore;
  #routing: DeviceRoutingStore;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, registry: DeviceRegistryStore, routing: DeviceRoutingStore, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-pool.json');
    this.#registry = registry;
    this.#routing = routing;
    this.#clock = options.clock ?? (() => new Date());
  }

  async reserve(requestInput: DevicePoolRequest, advertisementsInput: DeviceResourceAdvertisement[]): Promise<DeviceReservation> {
    const request = normalizeRequest(requestInput);
    const advertisements = validateAdvertisements(advertisementsInput, this.#clock, request.livenessMs);
    const registered = new Map((await this.#registry.listDevices()).filter((item) => item.status === 'active').map((item) => [item.deviceId, item]));
    const candidates = advertisements.filter((item) => registered.has(item.deviceId));

    let pinnedDeviceId: string | undefined = request.explicitDeviceId;
    if (!pinnedDeviceId && request.projectKey) {
      pinnedDeviceId = (await this.#routing.listBindings()).find((item) => item.projectKey === request.projectKey)?.deviceId;
    }
    if (!pinnedDeviceId) pinnedDeviceId = await this.#routing.defaultDevice();

    const run = this.#serial.then(async () => {
      const state = await this.#read();
      expireReservations(state, this.#clock().getTime());
      const activeByDevice = new Map<string, number>();
      for (const reservation of state.reservations.filter((item) => item.state === 'ACTIVE')) {
        activeByDevice.set(reservation.deviceId, (activeByDevice.get(reservation.deviceId) ?? 0) + reservation.slots);
      }

      const eligible = candidates.filter((candidate) => {
        if (pinnedDeviceId && candidate.deviceId !== pinnedDeviceId) return false;
        if (!request.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))) return false;
        if (!request.requiredTags.every((tag) => candidate.tags.includes(tag))) return false;
        if (request.requireGpu && !candidate.gpu) return false;
        if (candidate.memoryMb < request.minMemoryMb) return false;
        const used = candidate.activeJobs + (activeByDevice.get(candidate.deviceId) ?? 0);
        return used + request.slots <= candidate.maxConcurrentJobs;
      });

      if (eligible.length === 0) {
        if (pinnedDeviceId) throw new OperatorError('DEVICE_POOL_PINNED_UNAVAILABLE', 'Configured device cannot satisfy the requested workload capacity.');
        throw new OperatorError('DEVICE_POOL_NO_CAPACITY', 'No active paired device satisfies the workload requirements.');
      }

      eligible.sort((a, b) =>
        scoreDevice(b, request, activeByDevice.get(b.deviceId) ?? 0) - scoreDevice(a, request, activeByDevice.get(a.deviceId) ?? 0) ||
        a.deviceId.localeCompare(b.deviceId)
      );
      const selected = eligible[0]!;
      const now = this.#clock();
      if (state.reservations.length >= MAX_RESERVATIONS) {
        const reclaim = state.reservations.findIndex((item) => item.state !== 'ACTIVE');
        if (reclaim >= 0) state.reservations.splice(reclaim, 1);
        else throw new OperatorError('DEVICE_POOL_RESERVATION_LIMIT', 'Device reservation limit reached.');
      }
      const reservation: DeviceReservation = {
        id: crypto.randomUUID(),
        workloadKey: request.workloadKey,
        ...(request.projectKey ? { projectKey: request.projectKey } : {}),
        deviceId: selected.deviceId,
        sessionId: selected.sessionId,
        requiredCapabilities: request.requiredCapabilities,
        requiredTags: request.requiredTags,
        minMemoryMb: request.minMemoryMb,
        requireGpu: request.requireGpu,
        slots: request.slots,
        acquiredAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
        state: 'ACTIVE'
      };
      state.reservations.push(reservation);
      state.reservations.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.id.localeCompare(b.id));
      await this.#write(state);
      return structuredClone(reservation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async heartbeat(idInput: string, sessionIdInput: string, leaseMsInput?: number): Promise<DeviceReservation> {
    const id = validUuid(idInput, 'reservationId');
    const sessionId = validUuid(sessionIdInput, 'sessionId');
    const leaseMs = boundedInteger(leaseMsInput ?? 5 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseMs');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      expireReservations(state, this.#clock().getTime());
      const reservation = state.reservations.find((item) => item.id === id);
      if (!reservation || reservation.state !== 'ACTIVE') throw new OperatorError('DEVICE_POOL_RESERVATION_LOST', 'Device reservation is no longer active.');
      if (reservation.sessionId !== sessionId) throw new OperatorError('DEVICE_POOL_SESSION_CHANGED', 'Device session changed; reservation must be reacquired.');
      const now = this.#clock();
      reservation.heartbeatAt = now.toISOString();
      reservation.expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      await this.#write(state);
      return structuredClone(reservation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async release(idInput: string): Promise<DeviceReservation> {
    const id = validUuid(idInput, 'reservationId');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const reservation = state.reservations.find((item) => item.id === id);
      if (!reservation) throw new OperatorError('DEVICE_POOL_RESERVATION_NOT_FOUND', 'Device reservation was not found.');
      if (reservation.state === 'ACTIVE') reservation.state = 'RELEASED';
      await this.#write(state);
      return structuredClone(reservation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async list(input: { activeOnly?: boolean; deviceId?: string; limit?: number } = {}): Promise<DeviceReservation[]> {
    await this.#serial;
    const state = await this.#read();
    expireReservations(state, this.#clock().getTime());
    const deviceId = input.deviceId === undefined ? undefined : validUuid(input.deviceId, 'deviceId');
    const limit = boundedInteger(input.limit ?? 100, 1, 1000, 'limit');
    return state.reservations.filter((item) => (!input.activeOnly || item.state === 'ACTIVE') && (!deviceId || item.deviceId === deviceId))
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #read(): Promise<DevicePoolState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, reservations: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVICE_POOL_STATE_CORRUPT', 'Device pool state could not be read.');
    }
  }

  async #write(state: DevicePoolState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function scoreDevice(device: DeviceResourceAdvertisement, request: ReturnType<typeof normalizeRequest>, reservedSlots: number): number {
  const used = device.activeJobs + reservedSlots;
  const freeRatio = Math.max(0, (device.maxConcurrentJobs - used) / device.maxConcurrentJobs);
  const memoryRatio = request.minMemoryMb <= 0 ? Math.min(1, device.memoryMb / 32768) : Math.min(1, device.memoryMb / Math.max(request.minMemoryMb, 1));
  const capabilityBonus = request.requiredCapabilities.length === 0 ? 0 : request.requiredCapabilities.length / Math.max(device.capabilities.length, 1);
  const tagBonus = request.requiredTags.length === 0 ? 0 : request.requiredTags.length / Math.max(device.tags.length, 1);
  const gpuBonus = request.requireGpu && device.gpu ? 0.2 : 0;
  return freeRatio * 0.5 + memoryRatio * 0.2 + capabilityBonus * 0.15 + tagBonus * 0.1 + gpuBonus;
}

function normalizeRequest(input: DevicePoolRequest) {
  if (!input || typeof input !== 'object') throw new OperatorError('DEVICE_POOL_INPUT_INVALID', 'Device pool request is invalid.');
  return {
    workloadKey: boundedContext(input.workloadKey, 'workloadKey'),
    projectKey: input.projectKey === undefined ? undefined : boundedContext(input.projectKey, 'projectKey'),
    explicitDeviceId: input.explicitDeviceId === undefined ? undefined : validUuid(input.explicitDeviceId, 'explicitDeviceId'),
    requiredCapabilities: uniqueStrings(input.requiredCapabilities ?? [], MAX_CAPABILITIES, 256, 'requiredCapabilities'),
    requiredTags: uniqueStrings(input.requiredTags ?? [], MAX_TAGS, 128, 'requiredTags'),
    minMemoryMb: boundedInteger(input.minMemoryMb ?? 0, 0, 1024 * 1024, 'minMemoryMb'),
    requireGpu: input.requireGpu === true,
    slots: boundedInteger(input.slots ?? 1, 1, 64, 'slots'),
    leaseMs: boundedInteger(input.leaseMs ?? 5 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseMs'),
    livenessMs: boundedInteger(input.livenessMs ?? 45_000, 5_000, MAX_LIVENESS_MS, 'livenessMs')
  };
}

function validateAdvertisements(input: DeviceResourceAdvertisement[], clock: () => Date, livenessMs: number): DeviceResourceAdvertisement[] {
  if (!Array.isArray(input) || input.length > MAX_ADVERTISEMENTS) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', 'Device advertisements are invalid.');
  const now = clock().getTime();
  const seen = new Set<string>();
  return input.map((item, index) => {
    const deviceId = validUuid(item.deviceId, `advertisements[${index}].deviceId`);
    if (seen.has(deviceId)) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', 'Device advertisements contain duplicate device IDs.');
    seen.add(deviceId);
    const observedAt = validIso(item.observedAt, `advertisements[${index}].observedAt`);
    if (now - Date.parse(observedAt) > livenessMs || Date.parse(observedAt) > now + 5_000) throw new OperatorError('DEVICE_POOL_STALE_ADVERTISEMENT', 'Device resource advertisement is stale or future-dated.');
    return {
      deviceId,
      sessionId: validUuid(item.sessionId, `advertisements[${index}].sessionId`),
      capabilities: uniqueStrings(item.capabilities, MAX_CAPABILITIES, 256, 'capabilities'),
      observedAt,
      cpuSlots: boundedInteger(item.cpuSlots, 1, 1024, 'cpuSlots'),
      memoryMb: boundedInteger(item.memoryMb, 128, 16 * 1024 * 1024, 'memoryMb'),
      gpu: item.gpu === true,
      tags: uniqueStrings(item.tags, MAX_TAGS, 128, 'tags'),
      activeJobs: boundedInteger(item.activeJobs, 0, 1024, 'activeJobs'),
      maxConcurrentJobs: boundedInteger(item.maxConcurrentJobs, 1, 1024, 'maxConcurrentJobs')
    };
  });
}

function expireReservations(state: DevicePoolState, now: number): void {
  for (const reservation of state.reservations) if (reservation.state === 'ACTIVE' && Date.parse(reservation.expiresAt) <= now) reservation.state = 'EXPIRED';
}

function validateState(input: unknown): DevicePoolState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as DevicePoolState;
  if (state.version !== 1 || !Array.isArray(state.reservations) || state.reservations.length > MAX_RESERVATIONS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const item of state.reservations) {
    validUuid(item.id, 'reservation id'); validUuid(item.deviceId, 'deviceId'); validUuid(item.sessionId, 'sessionId'); boundedContext(item.workloadKey, 'workloadKey');
    if (ids.has(item.id)) throw corrupt('Reservation IDs must be unique.');
    ids.add(item.id);
    if (item.projectKey !== undefined) boundedContext(item.projectKey, 'projectKey');
    uniqueStrings(item.requiredCapabilities, MAX_CAPABILITIES, 256, 'requiredCapabilities');
    uniqueStrings(item.requiredTags, MAX_TAGS, 128, 'requiredTags');
    boundedInteger(item.minMemoryMb, 0, 1024 * 1024, 'minMemoryMb'); boundedInteger(item.slots, 1, 64, 'slots');
    if (typeof item.requireGpu !== 'boolean' || !['ACTIVE', 'RELEASED', 'EXPIRED'].includes(item.state)) throw corrupt('Reservation state is invalid.');
    validIso(item.acquiredAt, 'acquiredAt'); validIso(item.heartbeatAt, 'heartbeatAt'); validIso(item.expiresAt, 'expiresAt');
  }
  return structuredClone(state);
}

function uniqueStrings(input: unknown[], maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => {
    const text = String(value ?? '');
    if (!text || text.length > maxLength || text.includes('\0') || /[\r\n]/.test(text)) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label}[${index}] is invalid.`);
    return text;
  });
  if (new Set(values).size !== values.length) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} contains duplicates.`);
  return values.sort();
}
function boundedContext(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} must be UUID.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('DEVICE_POOL_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
function corrupt(message: string): OperatorError { return new OperatorError('DEVICE_POOL_STATE_CORRUPT', `Device pool state is invalid. ${message}`); }
