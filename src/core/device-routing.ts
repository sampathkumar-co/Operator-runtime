import path from 'node:path';
import { DeviceRegistryStore, type RegisteredDevice } from './device-registry.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_BINDINGS = 4096;
const MAX_ONLINE_DEVICES = 1000;
const MAX_CAPABILITIES = 256;
const DEFAULT_LIVENESS_MS = 45_000;
const MAX_LIVENESS_MS = 5 * 60_000;

type Clock = () => Date;

export interface ProjectDeviceBinding {
  projectKey: string;
  deviceId: string;
  updatedAt: string;
}

interface RoutingState {
  version: 1;
  bindings: ProjectDeviceBinding[];
}

export interface OnlineDeviceDescriptor {
  deviceId: string;
  sessionId: string;
  capabilities: string[];
  connectedAt: string;
  lastSeenAt: string;
}

export interface DeviceRouteRequest {
  requiredCapabilities?: string[];
  explicitDeviceId?: string;
  projectKey?: string;
  livenessMs?: number;
}

export interface DeviceRouteDecision {
  deviceId: string;
  sessionId: string;
  projectKey?: string;
  matchedCapabilities: string[];
  reason: 'explicit' | 'project-binding' | 'unique-candidate';
}

export class DeviceRoutingStore {
  #file: string;
  #registry: DeviceRegistryStore;
  #clock: Clock;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, registry: DeviceRegistryStore, options: { clock?: Clock } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'device-routing.json');
    this.#registry = registry;
    this.#clock = options.clock ?? (() => new Date());
  }

  async listBindings(): Promise<ProjectDeviceBinding[]> {
    const state = await this.#read();
    return state.bindings.map((binding) => ({ ...binding }));
  }

  async bindProject(projectKeyInput: string, deviceIdInput: string): Promise<ProjectDeviceBinding> {
    const projectKey = validProjectKey(projectKeyInput);
    const deviceId = validUuid(deviceIdInput, 'deviceId');
    await this.#requireActiveDevice(deviceId);
    return await this.#mutate((state) => {
      const existing = state.bindings.find((binding) => binding.projectKey === projectKey);
      const updatedAt = this.#clock().toISOString();
      if (existing) {
        existing.deviceId = deviceId;
        existing.updatedAt = updatedAt;
        return { ...existing };
      }
      if (state.bindings.length >= MAX_BINDINGS) throw new OperatorError('ROUTE_BINDING_LIMIT', `At most ${MAX_BINDINGS} project bindings may be stored.`);
      const binding = { projectKey, deviceId, updatedAt };
      state.bindings.push(binding);
      state.bindings.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
      return { ...binding };
    });
  }

  async unbindProject(projectKeyInput: string): Promise<boolean> {
    const projectKey = validProjectKey(projectKeyInput);
    return await this.#mutate((state) => {
      const before = state.bindings.length;
      state.bindings = state.bindings.filter((binding) => binding.projectKey !== projectKey);
      return state.bindings.length !== before;
    });
  }

  async resolve(requestInput: DeviceRouteRequest, onlineInput: OnlineDeviceDescriptor[]): Promise<DeviceRouteDecision> {
    const request = validateRequest(requestInput);
    const online = validateOnlineDevices(onlineInput, this.#clock(), request.livenessMs);
    const registered = await this.#registry.listDevices();
    const active = new Map(registered.filter((device) => device.status === 'active').map((device) => [device.deviceId, device]));
    const bindings = (await this.#read()).bindings;
    const binding = request.projectKey ? bindings.find((candidate) => candidate.projectKey === request.projectKey) : undefined;

    if (request.explicitDeviceId && binding && request.explicitDeviceId !== binding.deviceId) {
      throw new OperatorError('ROUTE_PROJECT_DEVICE_CONFLICT', 'Explicit device conflicts with the persisted project-to-device binding.', {
        details: { projectKey: request.projectKey, boundDeviceId: binding.deviceId, explicitDeviceId: request.explicitDeviceId }
      });
    }

    if (request.explicitDeviceId) {
      const candidate = requireRoutable(request.explicitDeviceId, online, active, request.requiredCapabilities, 'explicit');
      return decision(candidate, request, 'explicit');
    }

    if (binding) {
      const candidate = requireRoutable(binding.deviceId, online, active, request.requiredCapabilities, 'project binding');
      return decision(candidate, request, 'project-binding');
    }

    const candidates = online.filter((candidate) => active.has(candidate.deviceId) && hasCapabilities(candidate, request.requiredCapabilities));
    if (candidates.length === 0) {
      if (request.projectKey) {
        throw new OperatorError('ROUTE_PROJECT_UNBOUND', 'Project has no device binding and no unique eligible online device can be inferred safely.', {
          details: { projectKey: request.projectKey }
        });
      }
      throw new OperatorError('ROUTE_NO_DEVICE', 'No active online device satisfies the requested capabilities.');
    }
    if (candidates.length > 1) {
      throw new OperatorError('ROUTE_AMBIGUOUS', 'Multiple active online devices satisfy the route; select a device explicitly or bind the project.', {
        details: { candidateDeviceIds: candidates.map((candidate) => candidate.deviceId).sort() }
      });
    }
    return decision(candidates[0], request, 'unique-candidate');
  }

  async #requireActiveDevice(deviceId: string): Promise<RegisteredDevice> {
    const device = (await this.#registry.listDevices()).find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new OperatorError('DEVICE_NOT_FOUND', 'Cannot bind an unpaired device.');
    if (device.status !== 'active') throw new OperatorError('DEVICE_REVOKED', 'Cannot bind a revoked device.');
    return device;
  }

  async #read(): Promise<RoutingState> {
    try {
      const text = await readDurableStateText(this.#file, {
        maxBytes: 512 * 1024,
        errorCode: 'ROUTE_STATE_CORRUPT',
        invalidMessage: 'Device routing state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ROUTE_STATE_CORRUPT', 'Device routing state could not be read.');
    }
  }

  async #write(stateInput: RoutingState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {
      maxBytes: 512 * 1024,
      errorCode: 'ROUTE_STATE_CORRUPT',
      invalidMessage: 'Device routing state is invalid.'
    });
  }

  async #mutate<T>(mutator: (state: RoutingState) => T | Promise<T>): Promise<T> {
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

function validateRequest(input: DeviceRouteRequest): Required<Pick<DeviceRouteRequest, 'requiredCapabilities' | 'livenessMs'>> & Pick<DeviceRouteRequest, 'explicitDeviceId' | 'projectKey'> {
  if (!input || typeof input !== 'object') throw new OperatorError('ROUTE_REQUEST_INVALID', 'Device route request is invalid.');
  const requiredCapabilities = validCapabilities(input.requiredCapabilities ?? []);
  const explicitDeviceId = input.explicitDeviceId === undefined ? undefined : validUuid(input.explicitDeviceId, 'explicitDeviceId');
  const projectKey = input.projectKey === undefined ? undefined : validProjectKey(input.projectKey);
  const livenessMs = Number(input.livenessMs ?? DEFAULT_LIVENESS_MS);
  if (!Number.isInteger(livenessMs) || livenessMs < 5_000 || livenessMs > MAX_LIVENESS_MS) {
    throw new OperatorError('ROUTE_LIVENESS_INVALID', `livenessMs must be between 5000 and ${MAX_LIVENESS_MS}.`);
  }
  return { requiredCapabilities, explicitDeviceId, projectKey, livenessMs };
}

function validateOnlineDevices(input: OnlineDeviceDescriptor[], now: Date, livenessMs: number): OnlineDeviceDescriptor[] {
  if (!Array.isArray(input) || input.length > MAX_ONLINE_DEVICES) throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', `Online device list must contain at most ${MAX_ONLINE_DEVICES} entries.`);
  const seenDevices = new Set<string>();
  const seenSessions = new Set<string>();
  const nowMs = now.getTime();
  const result: OnlineDeviceDescriptor[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', 'Online device descriptor is invalid.');
    const deviceId = validUuid(raw.deviceId, 'online deviceId');
    const sessionId = validSessionId(raw.sessionId);
    if (seenDevices.has(deviceId)) throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', 'Online device list contains duplicate device IDs.');
    if (seenSessions.has(sessionId)) throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', 'Online device list contains duplicate session IDs.');
    seenDevices.add(deviceId);
    seenSessions.add(sessionId);
    const capabilities = validCapabilities(raw.capabilities);
    const connectedAt = validIso(raw.connectedAt, 'connectedAt');
    const lastSeenAt = validIso(raw.lastSeenAt, 'lastSeenAt');
    const connectedMs = Date.parse(connectedAt);
    const seenMs = Date.parse(lastSeenAt);
    if (seenMs < connectedMs || seenMs > nowMs + 30_000) throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', 'Online device timestamps are inconsistent.');
    if (nowMs - seenMs > livenessMs) continue;
    result.push({ deviceId, sessionId, capabilities, connectedAt, lastSeenAt });
  }
  return result;
}

function requireRoutable(
  deviceId: string,
  online: OnlineDeviceDescriptor[],
  active: Map<string, RegisteredDevice>,
  capabilities: string[],
  source: string
): OnlineDeviceDescriptor {
  if (!active.has(deviceId)) throw new OperatorError('ROUTE_DEVICE_INACTIVE', `The ${source} device is not an active paired device.`, { details: { deviceId } });
  const candidate = online.find((device) => device.deviceId === deviceId);
  if (!candidate) throw new OperatorError('ROUTE_DEVICE_OFFLINE', `The ${source} device is offline or stale.`, { retryable: true, details: { deviceId } });
  const missing = capabilities.filter((capability) => !candidate.capabilities.includes(capability));
  if (missing.length) throw new OperatorError('ROUTE_CAPABILITY_MISMATCH', `The ${source} device does not advertise every required capability.`, { details: { deviceId, missing } });
  return candidate;
}

function decision(candidate: OnlineDeviceDescriptor, request: ReturnType<typeof validateRequest>, reason: DeviceRouteDecision['reason']): DeviceRouteDecision {
  return {
    deviceId: candidate.deviceId,
    sessionId: candidate.sessionId,
    projectKey: request.projectKey,
    matchedCapabilities: [...request.requiredCapabilities],
    reason
  };
}

function hasCapabilities(device: OnlineDeviceDescriptor, required: string[]): boolean {
  return required.every((capability) => device.capabilities.includes(capability));
}

function validateState(input: RoutingState): RoutingState {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.bindings) || input.bindings.length > MAX_BINDINGS) {
    throw new OperatorError('ROUTE_STATE_CORRUPT', 'Device routing state structure is invalid.');
  }
  const projects = new Set<string>();
  const bindings = input.bindings.map((raw) => {
    const projectKey = validProjectKey(raw.projectKey);
    if (projects.has(projectKey)) throw new OperatorError('ROUTE_STATE_CORRUPT', 'Device routing state contains duplicate project keys.');
    projects.add(projectKey);
    return { projectKey, deviceId: validUuid(raw.deviceId, 'deviceId'), updatedAt: validIso(raw.updatedAt, 'updatedAt') };
  });
  return { version: 1, bindings };
}

function validCapabilities(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_CAPABILITIES) throw new OperatorError('ROUTE_CAPABILITY_INVALID', `Capabilities must contain at most ${MAX_CAPABILITIES} entries.`);
  const capabilities = input.map(String);
  for (const capability of capabilities) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/*-]{0,127}$/.test(capability)) throw new OperatorError('ROUTE_CAPABILITY_INVALID', `Invalid capability ${capability}.`);
  }
  return [...new Set(capabilities)].sort();
}

function validProjectKey(value: string): string {
  const key = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new OperatorError('ROUTE_PROJECT_KEY_INVALID', 'projectKey must be an opaque logical identifier, not a filesystem path.');
  if (key.includes('/') || key.includes('\\')) throw new OperatorError('ROUTE_PROJECT_KEY_INVALID', 'projectKey must not contain path separators.');
  return key;
}

function validSessionId(value: string): string {
  const id = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new OperatorError('ROUTE_ONLINE_STATE_INVALID', 'Relay session ID is invalid.');
  return id;
}

function validUuid(value: string, label: string): string {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new OperatorError('ROUTE_DEVICE_ID_INVALID', `${label} must be a UUID.`);
  return text.toLowerCase();
}

function validIso(value: string, label: string): string {
  const text = String(value ?? '');
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw new OperatorError('ROUTE_STATE_INVALID', `${label} must be an ISO timestamp.`);
  return text;
}
