import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ControlPlaneRecord, ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';

export type DistributedWorkerRole =
  | 'investigation'
  | 'implementation'
  | 'testing'
  | 'browser-ui'
  | 'performance'
  | 'compatibility'
  | 'verification'
  | 'packaging-signing'
  | 'incident-recovery';

export type DistributedOs = 'windows' | 'linux' | 'macos';
export type DistributedSecurityClass = 'standard' | 'sensitive' | 'restricted';
export type DistributedPosture = 'degraded' | 'managed' | 'trusted';
export type DistributedIsolationMode = 'disposable-workspace' | 'container' | 'vm';

export interface DistributedWorkerAdvertisement {
  schemaVersion: 1;
  workerId: string;
  deviceId: string;
  sessionId: string;
  role: DistributedWorkerRole;
  os: DistributedOs;
  capabilities: string[];
  tags: string[];
  securityClearance: DistributedSecurityClass;
  posture: DistributedPosture;
  cpuSlots: number;
  memoryMb: number;
  gpu: boolean;
  availablePorts: number;
  activeJobs: number;
  maxConcurrentJobs: number;
  artifactDigests: string[];
  dataLocalityTags: string[];
  isolationModes: DistributedIsolationMode[];
  latencyMs: number;
  estimatedCostMicros: number;
  trustScore: number;
  reliabilityScore: number;
  observedAt: string;
}

export interface DistributedWorkOrder {
  schemaVersion: 1;
  objectiveId: string;
  planId: string;
  workUnitId: string;
  authorityDigest: string;
  role: DistributedWorkerRole;
  requiredCapabilities: string[];
  resourceKeys: string[];
  requiredOs?: DistributedOs;
  securityClass: DistributedSecurityClass;
  minPosture: DistributedPosture;
  minMemoryMb: number;
  requireGpu: boolean;
  requiredPorts: number;
  requiredArtifactDigests: string[];
  dataLocalityTags: string[];
  allowedIsolationModes: DistributedIsolationMode[];
  maxLatencyMs: number;
  maxCostMicros: number;
  minTrustScore: number;
  minReliabilityScore: number;
  leaseMs: number;
}

export interface DistributedPlacementCandidate {
  worker: DistributedWorkerAdvertisement;
  eligible: boolean;
  reasons: string[];
  qualityScore: number;
  localityScore: number;
  capacityScore: number;
  latencyScore: number;
  costScore: number;
  totalScore: number;
}

export interface DistributedPlacementDecision {
  schemaVersion: 1;
  orderDigest: string;
  selectedWorkerId: string;
  selectedDeviceId: string;
  selectedSessionId: string;
  selectedIsolationMode: DistributedIsolationMode;
  score: number;
  candidates: DistributedPlacementCandidate[];
}

export interface DistributedIsolationEnvelope {
  schemaVersion: 1;
  objectiveId: string;
  planId: string;
  workUnitId: string;
  authorityDigest: string;
  workerId: string;
  deviceId: string;
  mode: DistributedIsolationMode;
  workspace: 'disposable';
  networkPolicy: 'deny-by-default' | 'restricted-egress';
  dataPolicy: 'artifact-only';
  exchangeMode: 'content-addressed-artifacts-only';
  rawSecretExchangeAllowed: false;
  resourceKeys: string[];
  conflictDigest: string;
  inputArtifactDigests: string[];
  digest: string;
}

export interface DistributedLineageReceipt {
  schemaVersion: 1;
  objectiveId: string;
  planId: string;
  workUnitId: string;
  workerId: string;
  deviceId: string;
  authorityDigest: string;
  leaseId: string;
  leaseEpoch: number;
  fenceToken: string;
  isolationDigest: string;
  resourceKeys: string[];
  actionIds: string[];
  evidenceIds: string[];
  verifierIds: string[];
  artifactIds: string[];
  parentLineageDigests: string[];
  outcome: 'VERIFIED' | 'FAILED' | 'RECOVERY_REQUIRED';
  digest: string;
}

export interface DistributedExecutionLease {
  schemaVersion: 1;
  leaseId: string;
  objectiveId: string;
  planId: string;
  workUnitId: string;
  workerId: string;
  deviceId: string;
  sessionId: string;
  authorityDigest: string;
  epoch: number;
  fenceToken: string;
  isolationDigest: string;
  resourceKeys: string[];
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED';
}

export interface AcceptedDistributedResult {
  schemaVersion: 1;
  objectiveId: string;
  planId: string;
  workUnitId: string;
  leaseId: string;
  leaseEpoch: number;
  lineageDigest: string;
  artifactIds: string[];
  evidenceIds: string[];
  verifierIds: string[];
  acceptedAt: string;
}

const NS = 'r9-distributed-fabric';
const SECURITY_ORDER: readonly DistributedSecurityClass[] = ['standard', 'sensitive', 'restricted'];
const POSTURE_ORDER: readonly DistributedPosture[] = ['degraded', 'managed', 'trusted'];
const ISOLATION_ORDER: readonly DistributedIsolationMode[] = ['disposable-workspace', 'container', 'vm'];

export function rankDistributedWorkers(
  orderInput: DistributedWorkOrder,
  workersInput: DistributedWorkerAdvertisement[],
  nowInput = new Date().toISOString()
): DistributedPlacementDecision {
  const order = normalizeOrder(orderInput);
  const now = iso(nowInput, 'now');
  if (!Array.isArray(workersInput) || workersInput.length < 1 || workersInput.length > 10_000) throw invalid('Worker advertisements are invalid.');
  const seen = new Set<string>();
  const candidates = workersInput.map((workerInput) => {
    const worker = normalizeWorker(workerInput);
    if (seen.has(worker.workerId)) throw invalid('Worker advertisements contain duplicate worker IDs.');
    seen.add(worker.workerId);
    const reasons: string[] = [];
    if (Date.parse(now) - Date.parse(worker.observedAt) > 120_000 || Date.parse(worker.observedAt) > Date.parse(now) + 5_000) reasons.push('worker advertisement is stale');
    if (worker.role !== order.role) reasons.push('specialized worker role does not match');
    if (order.requiredOs && worker.os !== order.requiredOs) reasons.push('OS requirement is not satisfied');
    if (SECURITY_ORDER.indexOf(worker.securityClearance) < SECURITY_ORDER.indexOf(order.securityClass)) reasons.push('security clearance is insufficient');
    if (POSTURE_ORDER.indexOf(worker.posture) < POSTURE_ORDER.indexOf(order.minPosture)) reasons.push('device posture is insufficient');
    for (const capability of order.requiredCapabilities) if (!worker.capabilities.includes(capability)) reasons.push('missing capability ' + capability);
    if (worker.memoryMb < order.minMemoryMb) reasons.push('memory capacity is insufficient');
    if (order.requireGpu && !worker.gpu) reasons.push('GPU is required');
    if (worker.availablePorts < order.requiredPorts) reasons.push('port capacity is insufficient');
    if (worker.activeJobs >= worker.maxConcurrentJobs) reasons.push('concurrency capacity is exhausted');
    if (worker.latencyMs > order.maxLatencyMs) reasons.push('latency exceeds the authority-bounded maximum');
    if (worker.estimatedCostMicros > order.maxCostMicros) reasons.push('cost exceeds the authority-bounded maximum');
    if (worker.trustScore < order.minTrustScore) reasons.push('trust score is below the required floor');
    if (worker.reliabilityScore < order.minReliabilityScore) reasons.push('reliability score is below the required floor');
    if (!worker.isolationModes.some((mode) => order.allowedIsolationModes.includes(mode))) reasons.push('no allowed isolation mode is available');

    const artifactHits = order.requiredArtifactDigests.filter((digestValue) => worker.artifactDigests.includes(digestValue)).length;
    const dataHits = order.dataLocalityTags.filter((tag) => worker.dataLocalityTags.includes(tag)).length;
    const localityDenom = Math.max(1, order.requiredArtifactDigests.length + order.dataLocalityTags.length);
    const localityScore = (artifactHits + dataHits) / localityDenom;
    const qualityScore = (worker.trustScore + worker.reliabilityScore) / 2;
    const capacityScore = Math.max(0, (worker.maxConcurrentJobs - worker.activeJobs) / worker.maxConcurrentJobs);
    const latencyScore = order.maxLatencyMs <= 0 ? 1 : Math.max(0, 1 - worker.latencyMs / order.maxLatencyMs);
    const costScore = order.maxCostMicros <= 0 ? 1 : Math.max(0, 1 - worker.estimatedCostMicros / order.maxCostMicros);
    const totalScore = round(
      qualityScore * 0.5 +
      localityScore * 0.2 +
      capacityScore * 0.15 +
      latencyScore * 0.1 +
      costScore * 0.05
    );
    return { worker, eligible: reasons.length === 0, reasons, qualityScore, localityScore: round(localityScore), capacityScore: round(capacityScore), latencyScore: round(latencyScore), costScore: round(costScore), totalScore };
  }).sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.totalScore - a.totalScore ||
    a.worker.workerId.localeCompare(b.worker.workerId)
  );

  const selected = candidates.find((candidate) => candidate.eligible);
  if (!selected) throw new OperatorError('DISTRIBUTED_PLACEMENT_UNAVAILABLE', 'No worker satisfies authority, locality, platform, isolation, quality and capacity constraints.', { retryable: true });
  const isolation = strongestCommonIsolation(order.allowedIsolationModes, selected.worker.isolationModes);
  const orderDigest = hash(order);
  return {
    schemaVersion: 1,
    orderDigest,
    selectedWorkerId: selected.worker.workerId,
    selectedDeviceId: selected.worker.deviceId,
    selectedSessionId: selected.worker.sessionId,
    selectedIsolationMode: isolation,
    score: selected.totalScore,
    candidates
  };
}

export function compileDistributedIsolation(
  orderInput: DistributedWorkOrder,
  placement: DistributedPlacementDecision
): DistributedIsolationEnvelope {
  const order = normalizeOrder(orderInput);
  if (placement.schemaVersion !== 1 || placement.orderDigest !== hash(order)) throw invalid('Placement is not bound to the supplied work order.');
  const base = {
    schemaVersion: 1 as const,
    objectiveId: order.objectiveId,
    planId: order.planId,
    workUnitId: order.workUnitId,
    authorityDigest: order.authorityDigest,
    workerId: id(placement.selectedWorkerId, 'selectedWorkerId'),
    deviceId: id(placement.selectedDeviceId, 'selectedDeviceId'),
    mode: placement.selectedIsolationMode,
    workspace: 'disposable' as const,
    networkPolicy: order.securityClass === 'standard' ? 'restricted-egress' as const : 'deny-by-default' as const,
    dataPolicy: 'artifact-only' as const,
    exchangeMode: 'content-addressed-artifacts-only' as const,
    rawSecretExchangeAllowed: false as const,
    resourceKeys: order.resourceKeys,
    conflictDigest: hash(order.resourceKeys),
    inputArtifactDigests: order.requiredArtifactDigests
  };
  return { ...base, digest: hash(base) };
}

export function createDistributedLineage(input: Omit<DistributedLineageReceipt, 'schemaVersion' | 'digest'>): DistributedLineageReceipt {
  const base = {
    schemaVersion: 1 as const,
    objectiveId: id(input.objectiveId, 'objectiveId'),
    planId: id(input.planId, 'planId'),
    workUnitId: id(input.workUnitId, 'workUnitId'),
    workerId: id(input.workerId, 'workerId'),
    deviceId: id(input.deviceId, 'deviceId'),
    authorityDigest: sha(input.authorityDigest, 'authorityDigest'),
    leaseId: id(input.leaseId, 'leaseId'),
    leaseEpoch: integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, 'leaseEpoch'),
    fenceToken: sha(input.fenceToken, 'fenceToken'),
    isolationDigest: sha(input.isolationDigest, 'isolationDigest'),
    resourceKeys: strings(input.resourceKeys, 5000, 2048, 'resourceKeys'),
    actionIds: strings(input.actionIds, 10000, 512, 'actionIds'),
    evidenceIds: shas(input.evidenceIds, 10000, 'evidenceIds'),
    verifierIds: strings(input.verifierIds, 1000, 512, 'verifierIds'),
    artifactIds: shas(input.artifactIds, 10000, 'artifactIds'),
    parentLineageDigests: shas(input.parentLineageDigests, 1000, 'parentLineageDigests'),
    outcome: input.outcome
  };
  if (!['VERIFIED', 'FAILED', 'RECOVERY_REQUIRED'].includes(base.outcome)) throw invalid('Lineage outcome is invalid.');
  if (base.actionIds.length < 1 || base.evidenceIds.length < 1 || base.verifierIds.length < 1) throw invalid('Distributed lineage requires action, evidence and verifier provenance.');
  return { ...base, digest: hash(base) };
}

export class DistributedEngineeringFabric {
  #store: ControlPlaneStore;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
  }

  async acquire(
    orderInput: DistributedWorkOrder,
    placement: DistributedPlacementDecision,
    isolationInput: DistributedIsolationEnvelope
  ): Promise<DistributedExecutionLease> {
    const order = normalizeOrder(orderInput);
    const isolation = normalizeIsolation(isolationInput);
    if (placement.orderDigest !== hash(order)) throw invalid('Placement does not match work order.');
    if (isolation.digest !== compileDistributedIsolation(order, placement).digest) throw invalid('Isolation envelope does not match placement.');
    const now = this.#clock().toISOString();
    const workKey = leaseKey(order);
    const current = await this.#store.get(NS, workKey);
    const live = current && (!current.expiresAt || Date.parse(current.expiresAt) > Date.parse(now));
    if (live) {
      const value = current.value as unknown as DistributedExecutionLease;
      if (value.state === 'COMPLETED') throw new OperatorError('DISTRIBUTED_WORK_ALREADY_COMPLETED', 'Distributed work unit is already completed.');
      throw new OperatorError('DISTRIBUTED_EXECUTION_DUPLICATE', 'Distributed work unit already has a live execution lease.', { retryable: true });
    }

    const resourceRecords = await Promise.all(order.resourceKeys.map((key) => this.#store.get(NS, resourceKey(key))));
    for (let index = 0; index < resourceRecords.length; index += 1) {
      const record = resourceRecords[index];
      if (record && (!record.expiresAt || Date.parse(record.expiresAt) > Date.parse(now))) {
        throw new OperatorError('DISTRIBUTED_RESOURCE_CONFLICT', 'A resource is already fenced by another live distributed work unit.', {
          retryable: true,
          details: { resourceKey: order.resourceKeys[index] }
        });
      }
    }

    const epoch = (current?.generation ?? 0) + 1;
    const leaseId = crypto.randomUUID();
    const fenceToken = hash({ objectiveId: order.objectiveId, planId: order.planId, workUnitId: order.workUnitId, epoch, leaseId, authorityDigest: order.authorityDigest, isolationDigest: isolation.digest });
    const expiresAt = new Date(Date.parse(now) + order.leaseMs).toISOString();
    const lease: DistributedExecutionLease = {
      schemaVersion: 1,
      leaseId,
      objectiveId: order.objectiveId,
      planId: order.planId,
      workUnitId: order.workUnitId,
      workerId: placement.selectedWorkerId,
      deviceId: placement.selectedDeviceId,
      sessionId: placement.selectedSessionId,
      authorityDigest: order.authorityDigest,
      epoch,
      fenceToken,
      isolationDigest: isolation.digest,
      resourceKeys: order.resourceKeys,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      state: 'ACTIVE'
    };
    const mutations = [{
      namespace: NS,
      key: workKey,
      expectedGeneration: live ? current!.generation : null,
      value: lease as unknown as Record<string, unknown>,
      expiresAt
    }, ...order.resourceKeys.map((key, index) => ({
      namespace: NS,
      key: resourceKey(key),
      expectedGeneration: resourceRecords[index] && resourceRecords[index]!.expiresAt && Date.parse(resourceRecords[index]!.expiresAt!) <= Date.parse(now)
        ? null
        : null,
      value: {
        schemaVersion: 1,
        resourceKeyDigest: shaOfText(key),
        objectiveId: order.objectiveId,
        workUnitId: order.workUnitId,
        leaseId,
        epoch,
        fenceToken,
        authorityDigest: order.authorityDigest
      },
      expiresAt
    }))];

    try {
      await this.#store.transact(mutations, now);
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'CONTROL_PLANE_CAS_MISMATCH') {
        throw new OperatorError('DISTRIBUTED_EXECUTION_RACE', 'Another scheduler won the distributed execution fence.', { retryable: true });
      }
      throw error;
    }
    return structuredClone(lease);
  }

  async heartbeat(input: {
    objectiveId: string;
    workUnitId: string;
    leaseId: string;
    workerId: string;
    sessionId: string;
    authorityDigest: string;
    epoch: number;
    fenceToken: string;
    leaseMs: number;
  }): Promise<DistributedExecutionLease> {
    const objectiveId = id(input.objectiveId, 'objectiveId');
    const workUnitId = id(input.workUnitId, 'workUnitId');
    const now = this.#clock().toISOString();
    const record = await this.#store.get(NS, leaseKey({ objectiveId, workUnitId }));
    const lease = activeLease(record, now);
    assertLeaseBinding(lease, input);
    const expiresAt = new Date(Date.parse(now) + integer(input.leaseMs, 10_000, 24 * 60 * 60_000, 'leaseMs')).toISOString();
    const renewed = { ...lease, heartbeatAt: now, expiresAt };
    const resourceRecords = await Promise.all(lease.resourceKeys.map((key) => this.#store.get(NS, resourceKey(key))));
    for (const resourceRecord of resourceRecords) {
      if (!resourceRecord) throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'A distributed resource fence disappeared.');
      const value = resourceRecord.value as Record<string, unknown>;
      if (value.leaseId !== lease.leaseId || value.fenceToken !== lease.fenceToken || value.epoch !== lease.epoch) {
        throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'A distributed resource fence changed ownership.');
      }
    }
    const verifiedResourceRecords = resourceRecords as ControlPlaneRecord[];
    await this.#store.transact([
      { namespace: NS, key: leaseKey(lease), expectedGeneration: record!.generation, value: renewed as unknown as Record<string, unknown>, expiresAt },
      ...verifiedResourceRecords.map((resourceRecord) => ({ namespace: NS, key: resourceRecord.key, expectedGeneration: resourceRecord.generation, value: resourceRecord.value, expiresAt }))
    ], now);
    return renewed;
  }

  async acceptResult(input: {
    lineage: DistributedLineageReceipt;
    artifactIds: string[];
  }): Promise<AcceptedDistributedResult> {
    const { digest: providedDigest, schemaVersion, ...lineageInput } = input.lineage;
    if (schemaVersion !== 1) throw invalid('Distributed lineage schema version is invalid.');
    const lineage = createDistributedLineage(lineageInput);
    if (providedDigest !== lineage.digest) throw invalid('Distributed lineage digest is invalid.');
    const now = this.#clock().toISOString();
    const record = await this.#store.get(NS, leaseKey(lineage));
    const lease = activeLease(record, now);
    if (
      lease.leaseId !== lineage.leaseId ||
      lease.epoch !== lineage.leaseEpoch ||
      lease.fenceToken !== lineage.fenceToken ||
      lease.authorityDigest !== lineage.authorityDigest ||
      lease.workerId !== lineage.workerId ||
      lease.deviceId !== lineage.deviceId ||
      lease.planId !== lineage.planId ||
      lease.isolationDigest !== lineage.isolationDigest
    ) throw new OperatorError('DISTRIBUTED_STALE_RESULT', 'Distributed result does not match the current fenced execution lease.');
    if (lineage.outcome === 'VERIFIED' && lineage.verifierIds.includes(lineage.workerId)) {
      throw new OperatorError('DISTRIBUTED_VERIFIER_NOT_INDEPENDENT', 'Verified distributed result requires a verifier distinct from the executing worker.');
    }
    const artifactIds = shas(input.artifactIds, 10000, 'artifactIds');
    for (const artifactId of artifactIds) if (!lineage.artifactIds.includes(artifactId)) throw invalid('Accepted artifact is not represented in distributed lineage.');
    const result: AcceptedDistributedResult = {
      schemaVersion: 1,
      objectiveId: lease.objectiveId,
      planId: lease.planId,
      workUnitId: lease.workUnitId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.epoch,
      lineageDigest: lineage.digest,
      artifactIds,
      evidenceIds: lineage.evidenceIds,
      verifierIds: lineage.verifierIds,
      acceptedAt: now
    };
    const terminal: DistributedExecutionLease = {
      ...lease,
      state: lineage.outcome === 'VERIFIED' ? 'COMPLETED' : lineage.outcome === 'FAILED' ? 'FAILED' : 'RECOVERY_REQUIRED',
      expiresAt: now,
      heartbeatAt: now
    };
    const resourceRecords = await Promise.all(lease.resourceKeys.map((key) => this.#store.get(NS, resourceKey(key))));
    for (const resourceRecord of resourceRecords) {
      if (!resourceRecord) throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'Distributed resource fence disappeared before result commit.');
      const value = resourceRecord.value as Record<string, unknown>;
      if (value.leaseId !== lease.leaseId || value.fenceToken !== lease.fenceToken || value.epoch !== lease.epoch) {
        throw new OperatorError('DISTRIBUTED_FENCE_LOST', 'Distributed resource fence changed before result commit.');
      }
    }
    const verifiedResourceRecords = resourceRecords as ControlPlaneRecord[];
    await this.#store.transact([
      { namespace: NS, key: leaseKey(lease), expectedGeneration: record!.generation, value: terminal as unknown as Record<string, unknown> },
      { namespace: NS, key: resultKey(lease), expectedGeneration: null, value: result as unknown as Record<string, unknown> },
      ...verifiedResourceRecords.map((resourceRecord) => ({ namespace: NS, key: resourceRecord.key, expectedGeneration: resourceRecord.generation, value: null }))
    ], now);
    return result;
  }

  async result(objectiveIdInput: string, workUnitIdInput: string): Promise<AcceptedDistributedResult | null> {
    const objectiveId = id(objectiveIdInput, 'objectiveId');
    const workUnitId = id(workUnitIdInput, 'workUnitId');
    const record = await this.#store.get(NS, resultKey({ objectiveId, workUnitId }));
    return record ? normalizeResult(record.value) : null;
  }
}

function normalizeOrder(input: DistributedWorkOrder): DistributedWorkOrder {
  if (!input || input.schemaVersion !== 1) throw invalid('Distributed work order schemaVersion must be 1.');
  const role = workerRole(input.role);
  const securityClass = security(input.securityClass);
  const minPosture = posture(input.minPosture);
  const allowedIsolationModes = isolationModes(input.allowedIsolationModes);
  if (allowedIsolationModes.length < 1) throw invalid('At least one isolation mode is required.');
  return {
    schemaVersion: 1,
    objectiveId: id(input.objectiveId, 'objectiveId'),
    planId: id(input.planId, 'planId'),
    workUnitId: id(input.workUnitId, 'workUnitId'),
    authorityDigest: sha(input.authorityDigest, 'authorityDigest'),
    role,
    requiredCapabilities: strings(input.requiredCapabilities, 512, 256, 'requiredCapabilities'),
    resourceKeys: strings(input.resourceKeys, 5000, 2048, 'resourceKeys'),
    ...(input.requiredOs ? { requiredOs: os(input.requiredOs) } : {}),
    securityClass,
    minPosture,
    minMemoryMb: integer(input.minMemoryMb, 0, 16 * 1024 * 1024, 'minMemoryMb'),
    requireGpu: input.requireGpu === true,
    requiredPorts: integer(input.requiredPorts, 0, 65535, 'requiredPorts'),
    requiredArtifactDigests: shas(input.requiredArtifactDigests, 10000, 'requiredArtifactDigests'),
    dataLocalityTags: strings(input.dataLocalityTags, 512, 256, 'dataLocalityTags'),
    allowedIsolationModes,
    maxLatencyMs: number(input.maxLatencyMs, 0, 24 * 60 * 60_000, 'maxLatencyMs'),
    maxCostMicros: integer(input.maxCostMicros, 0, Number.MAX_SAFE_INTEGER, 'maxCostMicros'),
    minTrustScore: score(input.minTrustScore, 'minTrustScore'),
    minReliabilityScore: score(input.minReliabilityScore, 'minReliabilityScore'),
    leaseMs: integer(input.leaseMs, 10_000, 24 * 60 * 60_000, 'leaseMs')
  };
}

function normalizeWorker(input: DistributedWorkerAdvertisement): DistributedWorkerAdvertisement {
  if (!input || input.schemaVersion !== 1) throw invalid('Worker advertisement schemaVersion must be 1.');
  return {
    schemaVersion: 1,
    workerId: id(input.workerId, 'workerId'),
    deviceId: id(input.deviceId, 'deviceId'),
    sessionId: id(input.sessionId, 'sessionId'),
    role: workerRole(input.role),
    os: os(input.os),
    capabilities: strings(input.capabilities, 512, 256, 'capabilities'),
    tags: strings(input.tags, 512, 256, 'tags'),
    securityClearance: security(input.securityClearance),
    posture: posture(input.posture),
    cpuSlots: integer(input.cpuSlots, 1, 4096, 'cpuSlots'),
    memoryMb: integer(input.memoryMb, 128, 16 * 1024 * 1024, 'memoryMb'),
    gpu: input.gpu === true,
    availablePorts: integer(input.availablePorts, 0, 65535, 'availablePorts'),
    activeJobs: integer(input.activeJobs, 0, 4096, 'activeJobs'),
    maxConcurrentJobs: integer(input.maxConcurrentJobs, 1, 4096, 'maxConcurrentJobs'),
    artifactDigests: shas(input.artifactDigests, 10000, 'artifactDigests'),
    dataLocalityTags: strings(input.dataLocalityTags, 512, 256, 'dataLocalityTags'),
    isolationModes: isolationModes(input.isolationModes),
    latencyMs: number(input.latencyMs, 0, 24 * 60 * 60_000, 'latencyMs'),
    estimatedCostMicros: integer(input.estimatedCostMicros, 0, Number.MAX_SAFE_INTEGER, 'estimatedCostMicros'),
    trustScore: score(input.trustScore, 'trustScore'),
    reliabilityScore: score(input.reliabilityScore, 'reliabilityScore'),
    observedAt: iso(input.observedAt, 'observedAt')
  };
}

function normalizeIsolation(input: DistributedIsolationEnvelope): DistributedIsolationEnvelope {
  if (!input || input.schemaVersion !== 1) throw invalid('Isolation envelope is invalid.');
  const base = {
    schemaVersion: 1 as const,
    objectiveId: id(input.objectiveId, 'objectiveId'),
    planId: id(input.planId, 'planId'),
    workUnitId: id(input.workUnitId, 'workUnitId'),
    authorityDigest: sha(input.authorityDigest, 'authorityDigest'),
    workerId: id(input.workerId, 'workerId'),
    deviceId: id(input.deviceId, 'deviceId'),
    mode: isolationMode(input.mode),
    workspace: input.workspace,
    networkPolicy: input.networkPolicy,
    dataPolicy: input.dataPolicy,
    exchangeMode: input.exchangeMode,
    rawSecretExchangeAllowed: input.rawSecretExchangeAllowed,
    resourceKeys: strings(input.resourceKeys, 5000, 2048, 'resourceKeys'),
    conflictDigest: sha(input.conflictDigest, 'conflictDigest'),
    inputArtifactDigests: shas(input.inputArtifactDigests, 10000, 'inputArtifactDigests')
  };
  if (base.workspace !== 'disposable' || !['deny-by-default', 'restricted-egress'].includes(base.networkPolicy)
    || base.dataPolicy !== 'artifact-only' || base.exchangeMode !== 'content-addressed-artifacts-only' || base.rawSecretExchangeAllowed !== false) {
    throw invalid('Isolation envelope weakens the mandatory isolation boundary.');
  }
  if (sha(input.digest, 'isolation.digest') !== hash(base)) throw invalid('Isolation envelope digest is invalid.');
  return { ...base, digest: input.digest.toLowerCase() };
}

function activeLease(record: ControlPlaneRecord | null, now: string): DistributedExecutionLease {
  if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(now))) {
    throw new OperatorError('DISTRIBUTED_LEASE_LOST', 'Distributed execution lease is absent or expired.');
  }
  const value = record.value as unknown as DistributedExecutionLease;
  if (value.schemaVersion !== 1 || value.state !== 'ACTIVE') throw new OperatorError('DISTRIBUTED_LEASE_LOST', 'Distributed execution lease is not active.');
  return value;
}

function assertLeaseBinding(lease: DistributedExecutionLease, input: {
  leaseId: string; workerId: string; sessionId: string; authorityDigest: string; epoch: number; fenceToken: string;
}): void {
  if (
    lease.leaseId !== id(input.leaseId, 'leaseId') ||
    lease.workerId !== id(input.workerId, 'workerId') ||
    lease.sessionId !== id(input.sessionId, 'sessionId') ||
    lease.authorityDigest !== sha(input.authorityDigest, 'authorityDigest') ||
    lease.epoch !== integer(input.epoch, 1, Number.MAX_SAFE_INTEGER, 'epoch') ||
    lease.fenceToken !== sha(input.fenceToken, 'fenceToken')
  ) throw new OperatorError('DISTRIBUTED_LEASE_LOST', 'Distributed lease identity or authority binding changed.');
}

function normalizeResult(input: Record<string, unknown>): AcceptedDistributedResult {
  const result = input as unknown as AcceptedDistributedResult;
  if (result.schemaVersion !== 1) throw invalid('Distributed result is invalid.');
  return {
    schemaVersion: 1,
    objectiveId: id(result.objectiveId, 'objectiveId'),
    planId: id(result.planId, 'planId'),
    workUnitId: id(result.workUnitId, 'workUnitId'),
    leaseId: id(result.leaseId, 'leaseId'),
    leaseEpoch: integer(result.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, 'leaseEpoch'),
    lineageDigest: sha(result.lineageDigest, 'lineageDigest'),
    artifactIds: shas(result.artifactIds, 10000, 'artifactIds'),
    evidenceIds: shas(result.evidenceIds, 10000, 'evidenceIds'),
    verifierIds: strings(result.verifierIds, 1000, 512, 'verifierIds'),
    acceptedAt: iso(result.acceptedAt, 'acceptedAt')
  };
}

function strongestCommonIsolation(allowed: DistributedIsolationMode[], worker: DistributedIsolationMode[]): DistributedIsolationMode {
  const common = ISOLATION_ORDER.filter((mode) => allowed.includes(mode) && worker.includes(mode));
  if (common.length < 1) throw invalid('No common isolation mode exists.');
  return common[common.length - 1]!;
}
function leaseKey(input: { objectiveId: string; workUnitId: string }): string { return 'lease:' + id(input.objectiveId, 'objectiveId') + ':' + id(input.workUnitId, 'workUnitId'); }
function resultKey(input: { objectiveId: string; workUnitId: string }): string { return 'result:' + id(input.objectiveId, 'objectiveId') + ':' + id(input.workUnitId, 'workUnitId'); }
function resourceKey(value: string): string { return 'resource:' + shaOfText(value); }
function workerRole(v: unknown): DistributedWorkerRole { const s=String(v??'') as DistributedWorkerRole; if(!['investigation','implementation','testing','browser-ui','performance','compatibility','verification','packaging-signing','incident-recovery'].includes(s))throw invalid('worker role is invalid.');return s; }
function os(v: unknown): DistributedOs { const s=String(v??'') as DistributedOs; if(!['windows','linux','macos'].includes(s))throw invalid('OS is invalid.');return s; }
function security(v: unknown): DistributedSecurityClass { const s=String(v??'') as DistributedSecurityClass; if(!SECURITY_ORDER.includes(s))throw invalid('security class is invalid.');return s; }
function posture(v: unknown): DistributedPosture { const s=String(v??'') as DistributedPosture; if(!POSTURE_ORDER.includes(s))throw invalid('posture is invalid.');return s; }
function isolationMode(v: unknown): DistributedIsolationMode { const s=String(v??'') as DistributedIsolationMode; if(!ISOLATION_ORDER.includes(s))throw invalid('isolation mode is invalid.');return s; }
function isolationModes(v: unknown): DistributedIsolationMode[] { if(!Array.isArray(v)||v.length>3)throw invalid('isolation modes are invalid.');return [...new Set(v.map(isolationMode))].sort((a,b)=>ISOLATION_ORDER.indexOf(a)-ISOLATION_ORDER.indexOf(b)); }
function id(v: unknown, label: string): string { const s=String(v??''); if(!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(s))throw invalid(label+' is invalid.'); return s; }
function strings(v: unknown, maxItems: number, maxLength: number, label: string): string[] { if(!Array.isArray(v)||v.length>maxItems)throw invalid(label+' is invalid.'); const out=v.map((x,i)=>{const s=String(x??'');if(!s||s.length>maxLength||s.includes('\0')||/[\r\n]/.test(s))throw invalid(label+'['+i+'] is invalid.');return s;}); return [...new Set(out)].sort(); }
function shas(v: unknown, maxItems: number, label: string): string[] { if(!Array.isArray(v)||v.length>maxItems)throw invalid(label+' is invalid.'); return [...new Set(v.map((x)=>sha(x,label)))].sort(); }
function sha(v: unknown, label: string): string { const s=String(v??'').toLowerCase(); if(!/^[0-9a-f]{64}$/.test(s))throw invalid(label+' must be SHA-256.'); return s; }
function iso(v: unknown, label: string): string { const s=String(v??''); if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' must be canonical ISO.'); return s; }
function integer(v: unknown, min: number, max: number, label: string): number { const n=Number(v); if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(label+' is invalid.'); return n; }
function number(v: unknown, min: number, max: number, label: string): number { const n=Number(v); if(!Number.isFinite(n)||n<min||n>max)throw invalid(label+' is invalid.'); return n; }
function score(v: unknown, label: string): number { return number(v,0,1,label); }
function round(v:number):number{return Math.round(v*1_000_000)/1_000_000;}
function hash(v: unknown): string { return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex'); }
function shaOfText(v:string):string{return crypto.createHash('sha256').update(v,'utf8').digest('hex');}
function invalid(message:string):OperatorError{return new OperatorError('DISTRIBUTED_FABRIC_INVALID',message);}
