import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { DeveloperWorktreeManager } from './developer-worktree.ts';
import { OperatorError } from './errors.ts';
import { resolveTrustedExecutable } from './trusted-executable.ts';

export type DeveloperContainerPhase =
  | 'CREATING'
  | 'CREATED'
  | 'ACTIVE'
  | 'RELEASING'
  | 'RELEASED';

export interface DeveloperContainerRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  worktreePath: string;
  expectedWorktreeFingerprint: string;
  image: string;
  commandDigest: string;
  containerName: string;
  containerId?: string;
  memoryMb: number;
  cpu: number;
  pidsLimit: number;
  phase: DeveloperContainerPhase;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperContainerInspection {
  record: DeveloperContainerRecord;
  exists: boolean;
  state?: string;
  fingerprint?: string;
}

export interface DeveloperDockerResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}

export type DeveloperDockerRunner = (
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<DeveloperDockerResult>;

const RECORD_OPTIONS = {
  maxBytes: 256 * 1024,
  errorCode: 'DEVELOPER_CONTAINER_STATE_CORRUPT',
  invalidMessage: 'Developer container state is invalid.'
} as const;
const SESSION_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/i;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,383}@sha256:[0-9a-f]{64}$/i;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class DeveloperContainerManager {
  #stateDir: string;
  #worktrees: DeveloperWorktreeManager;
  #runner: DeveloperDockerRunner;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(options: {
    allowedRepositoryRoots: string[];
    worktreeRoot: string;
    stateDir: string;
    dockerExecutable?: string;
    runner?: DeveloperDockerRunner;
    clock?: () => Date;
  }) {
    this.#stateDir = path.join(path.resolve(options.stateDir), 'developer-containers');
    this.#worktrees = new DeveloperWorktreeManager({
      allowedRepositoryRoots: options.allowedRepositoryRoots,
      worktreeRoot: options.worktreeRoot,
      stateDir: options.stateDir,
      clock: options.clock
    });
    this.#runner = options.runner ?? createDockerRunner(options.dockerExecutable ?? 'docker');
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    sessionId: string;
    expectedWorktreeFingerprint: string;
    image: string;
    command: string[];
    memoryMb?: number;
    cpu?: number;
    pidsLimit?: number;
    signal?: AbortSignal;
  }): Promise<DeveloperContainerInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(input.sessionId);
      const expectedWorktreeFingerprint = digest(input.expectedWorktreeFingerprint, 'expectedWorktreeFingerprint');
      const image = normalizePinnedImage(input.image);
      const command = normalizeCommand(input.command);
      const commandDigest = sha256(Buffer.from(canonicalJson(command), 'utf8'));
      const memoryMb = boundedInteger(input.memoryMb ?? 1024, 128, 8192, 'memoryMb');
      const cpu = boundedNumber(input.cpu ?? 2, 0.1, 8, 'cpu');
      const pidsLimit = boundedInteger(input.pidsLimit ?? 256, 32, 2048, 'pidsLimit');

      const worktree = await this.#worktrees.inspect(sessionId);
      if (
        worktree.record.phase !== 'ACTIVE' ||
        !worktree.exists ||
        worktree.fingerprint !== expectedWorktreeFingerprint
      ) {
        throw new OperatorError(
          'DEVELOPER_CONTAINER_WORKTREE_PRECONDITION_FAILED',
          'Developer container requires the exact active Developer Worktree fingerprint.',
          { retryable: true }
        );
      }

      const worktreePath = await canonicalRealDirectory(worktree.record.worktreePath);
      const identity = {
        schemaVersion: 1 as const,
        sessionId,
        worktreePath: canonicalPath(worktreePath),
        expectedWorktreeFingerprint,
        image: image.toLowerCase(),
        commandDigest,
        memoryMb,
        cpu,
        pidsLimit
      };
      const id = sha256(Buffer.from(canonicalJson(identity), 'utf8'));
      const containerName = 'mecord-dev-' + id.slice(0, 24);
      let record = await this.#readRecord(sessionId);

      if (record) {
        assertSameIntent(record, {
          ...identity,
          id,
          containerName
        });
        if (record.phase === 'RELEASED') {
          throw new OperatorError(
            'DEVELOPER_CONTAINER_SESSION_REUSED',
            'Released Developer container session IDs cannot be reused.'
          );
        }
        record = (await this.#reconcile(record, input.signal)).record;
        if (record.phase === 'ACTIVE') return await this.#inspectRecord(record, input.signal);
        if (record.phase === 'RELEASING') {
          throw new OperatorError(
            'DEVELOPER_CONTAINER_RELEASE_IN_PROGRESS',
            'Developer container release is already in progress.'
          );
        }
      } else {
        const now = this.#now();
        record = {
          schemaVersion: 1,
          id,
          sessionId,
          worktreePath,
          expectedWorktreeFingerprint,
          image,
          commandDigest,
          containerName,
          memoryMb,
          cpu,
          pidsLimit,
          phase: 'CREATING',
          createdAt: now,
          updatedAt: now
        };
        await this.#writeRecord(record);
      }

      const context = await localDockerContext(this.#runner, input.signal);

      if (record.phase === 'CREATING') {
        const discovered = await this.#discoverByOwnershipLabel(context, record, input.signal);
        if (discovered) {
          record = {
            ...record,
            containerId: discovered,
            phase: 'CREATED',
            updatedAt: this.#now()
          };
          await this.#writeRecord(record);
        } else {
          const result = await this.#run(
            context,
            buildDeveloperContainerCreateArgs(record, command),
            60_000,
            input.signal
          );
          if (result.code !== 0) {
            throw new OperatorError(
              'DEVELOPER_CONTAINER_CREATE_FAILED',
              boundedDockerError(result.stderr, 'docker create failed.'),
              { retryable: true }
            );
          }
          const containerId = result.stdout.trim().toLowerCase();
          if (!CONTAINER_ID.test(containerId)) {
            throw new OperatorError(
              'DEVELOPER_CONTAINER_OUTPUT_INVALID',
              'Docker create did not return one full container id.'
            );
          }
          const created = {
            ...record,
            containerId,
            phase: 'CREATED' as const,
            updatedAt: this.#now()
          };
          await this.#assertOwnedContainer(context, created, ['created'], input.signal);
          record = created;
          await this.#writeRecord(record);
        }
      }

      if (record.phase === 'CREATED') {
        if (!record.containerId) throw corrupt('Created container record has no container id.');
        await this.#assertOwnedContainer(context, record, ['created', 'exited'], input.signal);
        const started = await this.#run(context, ['start', record.containerId], 60_000, input.signal);
        if (started.code !== 0) {
          throw new OperatorError(
            'DEVELOPER_CONTAINER_START_FAILED',
            boundedDockerError(started.stderr, 'docker start failed.'),
            { retryable: true }
          );
        }
        await this.#assertOwnedContainer(context, record, ['running'], input.signal);
        record = {
          ...record,
          phase: 'ACTIVE',
          updatedAt: this.#now()
        };
        await this.#writeRecord(record);
      }

      return await this.#inspectRecord(record, input.signal);
    });
  }

  async inspect(
    sessionIdInput: string,
    signal?: AbortSignal
  ): Promise<DeveloperContainerInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(sessionIdInput);
      const record = await this.#requireRecord(sessionId);
      return await this.#reconcile(record, signal);
    });
  }

  async release(input: {
    sessionId: string;
    expectedContainerFingerprint: string;
    signal?: AbortSignal;
  }): Promise<DeveloperContainerInspection> {
    return await this.#enqueue(async () => {
      await this.#init();
      const sessionId = normalizeSessionId(input.sessionId);
      const expected = digest(input.expectedContainerFingerprint, 'expectedContainerFingerprint');
      let record = (await this.#reconcile(await this.#requireRecord(sessionId), input.signal)).record;

      if (record.phase === 'RELEASED') return { record, exists: false };
      if (record.phase === 'CREATING') {
        throw new OperatorError(
          'DEVELOPER_CONTAINER_CREATE_INCOMPLETE',
          'Developer container creation has no proven container identity yet.'
        );
      }

      const inspected = await this.#inspectRecord(record, input.signal);
      if (!inspected.exists || !inspected.fingerprint || inspected.fingerprint !== expected) {
        throw new OperatorError(
          'DEVELOPER_CONTAINER_STATE_CHANGED',
          'Developer container changed after the release precondition was captured.',
          { retryable: true }
        );
      }
      const containerId = record.containerId;
      if (!containerId) throw corrupt('Owned container id is missing.');

      record = {
        ...record,
        phase: 'RELEASING',
        updatedAt: this.#now()
      };
      await this.#writeRecord(record);

      const context = await localDockerContext(this.#runner, input.signal);
      const removed = await this.#run(
        context,
        ['rm', '--force', containerId],
        60_000,
        input.signal
      );
      if (removed.code !== 0) {
        const stillThere = await this.#tryInspect(context, containerId, input.signal);
        if (stillThere) {
          throw new OperatorError(
            'DEVELOPER_CONTAINER_RELEASE_FAILED',
            boundedDockerError(removed.stderr, 'docker rm --force failed.'),
            { retryable: true }
          );
        }
      }

      if (await this.#tryInspect(context, containerId, input.signal)) {
        throw new OperatorError(
          'DEVELOPER_CONTAINER_RELEASE_POSTCONDITION_FAILED',
          'Owned container still exists after docker rm --force.'
        );
      }

      const released: DeveloperContainerRecord = {
        ...record,
        phase: 'RELEASED',
        updatedAt: this.#now()
      };
      await this.#writeRecord(released);
      return { record: released, exists: false };
    });
  }

  async #reconcile(
    input: DeveloperContainerRecord,
    signal?: AbortSignal
  ): Promise<DeveloperContainerInspection> {
    let record = validateRecord(input);
    const context = await localDockerContext(this.#runner, signal);

    if (record.phase === 'RELEASED') {
      if (record.containerId && await this.#tryInspect(context, record.containerId, signal)) {
        throw new OperatorError(
          'DEVELOPER_CONTAINER_RELEASE_CONTRADICTED',
          'Released Developer container unexpectedly still exists.'
        );
      }
      return { record, exists: false };
    }

    if (record.phase === 'CREATING') {
      const discovered = await this.#discoverByOwnershipLabel(context, record, signal);
      if (!discovered) return { record, exists: false };
      record = {
        ...record,
        containerId: discovered,
        phase: 'CREATED',
        updatedAt: this.#now()
      };
      await this.#writeRecord(record);
    }

    if (!record.containerId) throw corrupt('Committed container record has no container id.');

    if (record.phase === 'RELEASING') {
      const current = await this.#tryInspect(context, record.containerId, signal);
      if (!current) {
        const released: DeveloperContainerRecord = {
          ...record,
          phase: 'RELEASED',
          updatedAt: this.#now()
        };
        await this.#writeRecord(released);
        return { record: released, exists: false };
      }
      await validateInspectPayload(record, current);
      return await this.#inspectionFromPayload(record, current);
    }

    const current = await this.#tryInspect(context, record.containerId, signal);
    if (!current) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_MISSING',
        'Durably owned Developer container is missing unexpectedly.'
      );
    }
    await validateInspectPayload(record, current);
    const state = inspectState(current);
    if (record.phase === 'CREATED' && state === 'running') {
      record = { ...record, phase: 'ACTIVE', updatedAt: this.#now() };
      await this.#writeRecord(record);
    } else if (
      record.phase === 'ACTIVE' &&
      (state === 'created' || state === 'exited')
    ) {
      // A host reboot or daemon restart can stop an exact owned container
      // without changing its immutable image/mount/isolation identity. Demote
      // to CREATED so create() may re-run the explicit start + postcondition.
      record = { ...record, phase: 'CREATED', updatedAt: this.#now() };
      await this.#writeRecord(record);
    } else if (record.phase === 'ACTIVE' && state !== 'running') {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_STATE_CONTRADICTED',
        'Active Developer container entered an unsupported state.',
        { details: { state } }
      );
    }
    return await this.#inspectionFromPayload(record, current);
  }

  async #inspectRecord(
    record: DeveloperContainerRecord,
    signal?: AbortSignal
  ): Promise<DeveloperContainerInspection> {
    if (record.phase === 'RELEASED') return { record, exists: false };
    if (!record.containerId) return { record, exists: false };
    const context = await localDockerContext(this.#runner, signal);
    const payload = await this.#tryInspect(context, record.containerId, signal);
    if (!payload) return { record, exists: false };
    await validateInspectPayload(record, payload);
    return await this.#inspectionFromPayload(record, payload);
  }

  async #inspectionFromPayload(
    record: DeveloperContainerRecord,
    payload: DockerInspectPayload
  ): Promise<DeveloperContainerInspection> {
    const state = inspectState(payload);
    const fingerprint = sha256(Buffer.from(canonicalJson({
      id: record.id,
      containerId: record.containerId,
      image: record.image.toLowerCase(),
      worktreePath: canonicalPath(record.worktreePath),
      state
    }), 'utf8'));
    return { record, exists: true, state, fingerprint };
  }

  async #assertOwnedContainer(
    context: string,
    record: DeveloperContainerRecord,
    allowedStates: string[],
    signal?: AbortSignal
  ): Promise<void> {
    if (!record.containerId) throw corrupt('Owned container id is missing.');
    const payload = await this.#tryInspect(context, record.containerId, signal);
    if (!payload) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_MISSING',
        'Expected Developer container does not exist.'
      );
    }
    await validateInspectPayload(record, payload);
    const state = inspectState(payload);
    if (!allowedStates.includes(state)) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_STATE_INVALID',
        'Developer container is in an unexpected state.',
        { details: { state, allowedStates } }
      );
    }
  }

  async #discoverByOwnershipLabel(
    context: string,
    record: DeveloperContainerRecord,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const result = await this.#run(
      context,
      [
        'ps', '--all', '--quiet',
        '--filter', 'label=io.mecord.developer-container=' + record.id,
        '--filter', 'name=^/' + record.containerName + '$'
      ],
      30_000,
      signal
    );
    if (result.code !== 0) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_DISCOVERY_FAILED',
        boundedDockerError(result.stderr, 'docker ps failed.'),
        { retryable: true }
      );
    }
    const ids = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (ids.length > 1 || ids.some((item) => !/^[0-9a-f]{12,64}$/.test(item))) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_DISCOVERY_AMBIGUOUS',
        'Developer container ownership discovery returned ambiguous ids.'
      );
    }
    if (ids.length === 0) return undefined;
    const full = await this.#run(context, ['inspect', '--format', '{{.Id}}', ids[0]!], 30_000, signal);
    const id = full.stdout.trim().toLowerCase();
    if (full.code !== 0 || !CONTAINER_ID.test(id)) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_DISCOVERY_AMBIGUOUS',
        'Developer container ownership could not be expanded to one full id.'
      );
    }
    const payload = await this.#tryInspect(context, id, signal);
    if (!payload) throw new OperatorError('DEVELOPER_CONTAINER_DISCOVERY_AMBIGUOUS', 'Discovered Developer container disappeared.');
    const candidate: DeveloperContainerRecord = { ...record, containerId: id };
    await validateInspectPayload(candidate, payload);
    return id;
  }

  async #tryInspect(
    context: string,
    containerId: string,
    signal?: AbortSignal
  ): Promise<DockerInspectPayload | undefined> {
    const result = await this.#run(context, ['inspect', containerId], 30_000, signal);
    if (result.code !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return undefined;
      throw new OperatorError(
        'DEVELOPER_CONTAINER_INSPECT_FAILED',
        boundedDockerError(result.stderr, 'docker inspect failed.'),
        { retryable: true }
      );
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch {
      throw new OperatorError('DEVELOPER_CONTAINER_OUTPUT_INVALID', 'docker inspect output is not valid JSON.');
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
      throw new OperatorError('DEVELOPER_CONTAINER_OUTPUT_INVALID', 'docker inspect output must contain exactly one object.');
    }
    return parsed[0] as DockerInspectPayload;
  }

  async #run(
    context: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<DeveloperDockerResult> {
    return await this.#runner(['--context', context, ...args], timeoutMs, signal);
  }

  async #readRecord(sessionId: string): Promise<DeveloperContainerRecord | undefined> {
    try {
      return validateRecord(JSON.parse(await readDurableStateText(this.#file(sessionId), RECORD_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError) throw corrupt('Developer container record contains invalid JSON.');
      throw error;
    }
  }

  async #requireRecord(sessionId: string): Promise<DeveloperContainerRecord> {
    const record = await this.#readRecord(sessionId);
    if (!record) throw new OperatorError('DEVELOPER_CONTAINER_NOT_FOUND', 'Developer container session was not found.');
    return record;
  }

  async #writeRecord(input: DeveloperContainerRecord): Promise<void> {
    const record = validateRecord(input);
    await writeDurableStateText(this.#file(record.sessionId), JSON.stringify(record, null, 2), RECORD_OPTIONS);
  }

  async #init(): Promise<void> {
    await fs.mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OperatorError(
        'DEVELOPER_CONTAINER_STATE_UNSAFE',
        'Developer container state directory must be a real directory.'
      );
    }
  }

  #file(sessionId: string): string {
    return path.join(this.#stateDir, normalizeSessionId(sessionId) + '.json');
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

type DockerInspectPayload = {
  Id?: unknown;
  Name?: unknown;
  Config?: {
    Image?: unknown;
    Labels?: Record<string, unknown> | null;
  };
  State?: { Status?: unknown };
  HostConfig?: {
    NetworkMode?: unknown;
    ReadonlyRootfs?: unknown;
    CapDrop?: unknown;
    SecurityOpt?: unknown;
    PidsLimit?: unknown;
    Memory?: unknown;
    NanoCpus?: unknown;
  };
  Mounts?: Array<{
    Type?: unknown;
    Source?: unknown;
    Destination?: unknown;
    RW?: unknown;
  }>;
};

export function buildDeveloperContainerCreateArgs(record: DeveloperContainerRecord, command: string[]): string[] {
  return [
    'create',
    '--pull', 'never',
    '--name', record.containerName,
    '--label', 'io.mecord.developer-container=' + record.id,
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(record.pidsLimit),
    '--memory', String(record.memoryMb) + 'm',
    '--cpus', String(record.cpu),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', 'type=bind,src=' + record.worktreePath + ',dst=/workspace',
    '--workdir', '/workspace',
    record.image,
    ...command
  ];
}

async function validateInspectPayload(
  record: DeveloperContainerRecord,
  payload: DockerInspectPayload
): Promise<void> {
  if (String(payload.Id ?? '').toLowerCase() !== String(record.containerId ?? '').toLowerCase()) {
    throw new OperatorError('DEVELOPER_CONTAINER_IDENTITY_MISMATCH', 'Docker container id changed.');
  }
  if (String(payload.Config?.Image ?? '').toLowerCase() !== record.image.toLowerCase()) {
    throw new OperatorError('DEVELOPER_CONTAINER_IMAGE_MISMATCH', 'Docker container image changed.');
  }
  if (String(payload.Config?.Labels?.['io.mecord.developer-container'] ?? '') !== record.id) {
    throw new OperatorError('DEVELOPER_CONTAINER_LABEL_MISMATCH', 'Docker ownership label changed.');
  }
  if (String(payload.HostConfig?.NetworkMode ?? '') !== 'none') {
    throw new OperatorError('DEVELOPER_CONTAINER_ISOLATION_FAILED', 'Developer container network must be disabled.');
  }
  if (payload.HostConfig?.ReadonlyRootfs !== true) {
    throw new OperatorError('DEVELOPER_CONTAINER_ISOLATION_FAILED', 'Developer container root filesystem must be read-only.');
  }
  const capDrop = Array.isArray(payload.HostConfig?.CapDrop)
    ? payload.HostConfig!.CapDrop!.map((item) => String(item).toUpperCase())
    : [];
  if (!capDrop.includes('ALL')) {
    throw new OperatorError('DEVELOPER_CONTAINER_ISOLATION_FAILED', 'Developer container capabilities are not fully dropped.');
  }
  const security = Array.isArray(payload.HostConfig?.SecurityOpt)
    ? payload.HostConfig!.SecurityOpt!.map(String)
    : [];
  if (!security.some((item) => item === 'no-new-privileges' || item === 'no-new-privileges:true')) {
    throw new OperatorError('DEVELOPER_CONTAINER_ISOLATION_FAILED', 'Developer container privilege escalation is not disabled.');
  }
  if (Number(payload.HostConfig?.PidsLimit) !== record.pidsLimit) {
    throw new OperatorError('DEVELOPER_CONTAINER_RESOURCE_MISMATCH', 'Developer container PID limit changed.');
  }
  const expectedMemory = record.memoryMb * 1024 * 1024;
  if (Number(payload.HostConfig?.Memory) !== expectedMemory) {
    throw new OperatorError('DEVELOPER_CONTAINER_RESOURCE_MISMATCH', 'Developer container memory limit changed.');
  }
  const expectedNano = Math.round(record.cpu * 1_000_000_000);
  if (Number(payload.HostConfig?.NanoCpus) !== expectedNano) {
    throw new OperatorError('DEVELOPER_CONTAINER_RESOURCE_MISMATCH', 'Developer container CPU limit changed.');
  }
  const mounts = Array.isArray(payload.Mounts) ? payload.Mounts : [];
  const workspace = mounts.filter((item) => String(item.Destination ?? '') === '/workspace');
  if (workspace.length !== 1) {
    throw new OperatorError('DEVELOPER_CONTAINER_MOUNT_INVALID', 'Developer container requires exactly one /workspace mount.');
  }
  const unexpectedMounts = mounts.filter((item) => {
    const destination = String(item.Destination ?? '');
    const type = String(item.Type ?? '');
    return destination !== '/workspace' && !(destination === '/tmp' && type === 'tmpfs');
  });
  if (unexpectedMounts.length > 0) {
    throw new OperatorError(
      'DEVELOPER_CONTAINER_MOUNT_INVALID',
      'Developer container contains an undeclared host or volume mount.'
    );
  }
  const mount = workspace[0]!;
  if (
    String(mount.Type ?? '') !== 'bind' ||
    mount.RW !== true ||
    !sameLocalPath(String(mount.Source ?? ''), record.worktreePath)
  ) {
    throw new OperatorError('DEVELOPER_CONTAINER_MOUNT_INVALID', 'Developer container workspace mount no longer matches its owned worktree.');
  }
}

function inspectState(payload: DockerInspectPayload): string {
  const state = String(payload.State?.Status ?? '').toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(state)) {
    throw new OperatorError('DEVELOPER_CONTAINER_OUTPUT_INVALID', 'Docker container state is invalid.');
  }
  return state;
}

function validateRecord(input: unknown): DeveloperContainerRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Developer container record must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('Developer container schemaVersion must be 1.');
  const id = digest(raw.id, 'id');
  const sessionId = normalizeSessionId(raw.sessionId);
  const worktreePath = String(raw.worktreePath ?? '');
  if (!path.isAbsolute(worktreePath) || worktreePath.includes('\0')) throw corrupt('Developer container worktreePath is invalid.');
  const expectedWorktreeFingerprint = digest(raw.expectedWorktreeFingerprint, 'expectedWorktreeFingerprint');
  const image = normalizePinnedImage(raw.image);
  const commandDigest = digest(raw.commandDigest, 'commandDigest');
  const containerName = String(raw.containerName ?? '');
  if (!/^mecord-dev-[0-9a-f]{24}$/.test(containerName)) throw corrupt('Developer container name is invalid.');
  const containerId = raw.containerId === undefined ? undefined : String(raw.containerId).toLowerCase();
  if (containerId !== undefined && !CONTAINER_ID.test(containerId)) throw corrupt('Developer container id is invalid.');
  const memoryMb = boundedInteger(raw.memoryMb, 128, 8192, 'memoryMb');
  const cpu = boundedNumber(raw.cpu, 0.1, 8, 'cpu');
  const pidsLimit = boundedInteger(raw.pidsLimit, 32, 2048, 'pidsLimit');
  const phases: DeveloperContainerPhase[] = ['CREATING', 'CREATED', 'ACTIVE', 'RELEASING', 'RELEASED'];
  if (typeof raw.phase !== 'string' || !phases.includes(raw.phase as DeveloperContainerPhase)) throw corrupt('Developer container phase is invalid.');
  if (['CREATED', 'ACTIVE', 'RELEASING'].includes(String(raw.phase)) && !containerId) {
    throw corrupt('Committed Developer container phase requires containerId.');
  }
  const immutableIdentity = {
    schemaVersion: 1 as const,
    sessionId,
    worktreePath: canonicalPath(worktreePath),
    expectedWorktreeFingerprint,
    image: image.toLowerCase(),
    commandDigest,
    memoryMb,
    cpu,
    pidsLimit
  };
  const recomputedId = sha256(Buffer.from(canonicalJson(immutableIdentity), 'utf8'));
  if (id !== recomputedId || containerName !== 'mecord-dev-' + id.slice(0, 24)) {
    throw corrupt('Developer container record identity does not match immutable environment intent.');
  }
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw corrupt('updatedAt precedes createdAt.');
  return {
    schemaVersion: 1,
    id,
    sessionId,
    worktreePath: path.resolve(worktreePath),
    expectedWorktreeFingerprint,
    image,
    commandDigest,
    containerName,
    ...(containerId ? { containerId } : {}),
    memoryMb,
    cpu,
    pidsLimit,
    phase: raw.phase as DeveloperContainerPhase,
    createdAt,
    updatedAt
  };
}

function assertSameIntent(
  record: DeveloperContainerRecord,
  expected: {
    id: string;
    sessionId: string;
    worktreePath: string;
    expectedWorktreeFingerprint: string;
    image: string;
    commandDigest: string;
    containerName: string;
    memoryMb: number;
    cpu: number;
    pidsLimit: number;
  }
): void {
  const same =
    record.id === expected.id &&
    record.sessionId === expected.sessionId &&
    canonicalPath(record.worktreePath) === canonicalPath(expected.worktreePath) &&
    record.expectedWorktreeFingerprint === expected.expectedWorktreeFingerprint &&
    record.image.toLowerCase() === expected.image.toLowerCase() &&
    record.commandDigest === expected.commandDigest &&
    record.containerName === expected.containerName &&
    record.memoryMb === expected.memoryMb &&
    record.cpu === expected.cpu &&
    record.pidsLimit === expected.pidsLimit;
  if (!same) {
    throw new OperatorError(
      'DEVELOPER_CONTAINER_INTENT_CONFLICT',
      'Developer container session is already bound to different immutable environment intent.'
    );
  }
}

function normalizeSessionId(input: unknown): string {
  const value = String(input ?? '');
  if (!SESSION_ID.test(value)) throw new OperatorError('DEVELOPER_CONTAINER_INPUT_INVALID', 'sessionId is invalid.');
  return value;
}

function normalizePinnedImage(input: unknown): string {
  const value = String(input ?? '');
  if (!IMAGE.test(value)) {
    throw new OperatorError(
      'DEVELOPER_CONTAINER_IMAGE_UNPINNED',
      'Developer container image must be pinned by sha256 digest.'
    );
  }
  return value;
}

function normalizeCommand(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 128) {
    throw new OperatorError('DEVELOPER_CONTAINER_COMMAND_INVALID', 'Container command must contain 1-128 argv entries.');
  }
  return input.map((item) => {
    const value = String(item);
    if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 8192) {
      throw new OperatorError('DEVELOPER_CONTAINER_COMMAND_INVALID', 'Container command argv entry is invalid.');
    }
    return value;
  });
}

async function canonicalRealDirectory(input: string): Promise<string> {
  const stat = await fs.lstat(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperatorError('DEVELOPER_CONTAINER_WORKTREE_UNSAFE', 'Developer worktree must be a real directory.');
  }
  return await fs.realpath(input);
}

function canonicalPath(input: string): string {
  const value = path.resolve(input).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function sameLocalPath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!DIGEST.test(value)) throw new OperatorError('DEVELOPER_CONTAINER_INPUT_INVALID', label + ' must be SHA-256.');
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new OperatorError('DEVELOPER_CONTAINER_INPUT_INVALID', label + ' is invalid.');
  }
  return parsed;
}

function boundedNumber(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new OperatorError('DEVELOPER_CONTAINER_INPUT_INVALID', label + ' is invalid.');
  }
  return parsed;
}

function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new OperatorError('DEVELOPER_CONTAINER_INPUT_INVALID', label + ' must be canonical ISO.');
  }
  return text;
}

async function localDockerContext(
  runner: DeveloperDockerRunner,
  signal?: AbortSignal
): Promise<string> {
  const shown = await runner(['context', 'show'], 15_000, signal);
  if (shown.code !== 0) {
    throw new OperatorError('DEVELOPER_CONTAINER_DOCKER_UNAVAILABLE', boundedDockerError(shown.stderr, 'Docker context show failed.'), { retryable: true });
  }
  const name = shown.stdout.trim();
  if (!name || name.length > 256 || /[\r\n\0]/.test(name)) {
    throw new OperatorError('DEVELOPER_CONTAINER_DOCKER_CONTEXT_INVALID', 'Docker returned an invalid context.');
  }
  const inspected = await runner(['context', 'inspect', name, '--format', '{{json .Endpoints.docker.Host}}'], 15_000, signal);
  if (inspected.code !== 0) {
    throw new OperatorError('DEVELOPER_CONTAINER_DOCKER_UNAVAILABLE', boundedDockerError(inspected.stderr, 'Docker context inspect failed.'), { retryable: true });
  }
  let host: unknown;
  try { host = JSON.parse(inspected.stdout.trim()); }
  catch {
    throw new OperatorError('DEVELOPER_CONTAINER_DOCKER_CONTEXT_INVALID', 'Docker endpoint could not be parsed.');
  }
  if (typeof host !== 'string' || !isLocalDockerHost(host)) {
    throw new OperatorError(
      'DEVELOPER_CONTAINER_REMOTE_DOCKER_DENIED',
      'Developer containers permit only a local Docker daemon.'
    );
  }
  return name;
}

function isLocalDockerHost(host: string): boolean {
  if (/^unix:\/\/\//i.test(host)) return true;
  if (/^npipe:\/\//i.test(host)) return true;
  if (/^tcp:\/\//i.test(host)) {
    try {
      const url = new URL('http://' + host.slice('tcp://'.length));
      const name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return name === 'localhost' || name === '127.0.0.1' || name === '::1';
    } catch { return false; }
  }
  return false;
}

function createDockerRunner(executable: string): DeveloperDockerRunner {
  return async (args, timeoutMs, signal) => await runDocker(executable, args, timeoutMs, signal);
}

async function runDocker(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<DeveloperDockerResult> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperatorError('EXECUTION_ABORTED', 'Developer container operation was cancelled.'));
      return;
    }
    const env = dockerEnvironment();
    const resolved = resolveTrustedExecutable(executable, env);
    const child = spawn(resolved, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      bucket.push(slice);
      bytes += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const terminate = () => { try { child.kill('SIGKILL'); } catch {} };
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'Developer container operation was cancelled.'));
        return;
      }
      if (timedOut) {
        reject(new OperatorError('DEVELOPER_CONTAINER_TIMEOUT', 'Docker operation timed out.', { retryable: true }));
        return;
      }
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      });
    });
  });
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function boundedDockerError(stderr: string, fallback: string): string {
  const text = String(stderr ?? '').trim().replace(/[\r\n\t]+/g, ' ');
  return (text || fallback).slice(0, 1200);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function corrupt(message: string): OperatorError {
  return new OperatorError('DEVELOPER_CONTAINER_STATE_CORRUPT', message);
}
