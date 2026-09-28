import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { createDurableStateBytes, readDurableStateText, writeDurableStateText } from './durable-state.ts';
import type { ActionRisk, SideEffectState } from './types.ts';\nimport { validSideEffectState } from './side-effect.ts';

export type TeamRole = 'supervisor' | 'planner' | 'coder' | 'tester' | 'browser' | 'ui' | 'verifier' | 'general';
export type TeamMissionState = 'PENDING' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'VERIFIED';
export type TeamWorkState = 'PENDING' | 'LEASED' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'NEEDS_RECONCILIATION' | 'CANCELLED';

export interface TeamBudget {
  maxWorkers: number;
  maxConcurrentLeases: number;
  maxAttemptsPerWorkItem: number;
  maxWallClockMs: number;
  leaseMs: number;
}

export interface TeamWorker {
  id: string;
  role: TeamRole;
  label: string;
  capabilities: string[];
  registeredAt: string;
  heartbeatAt: string;
  state: 'ACTIVE' | 'OFFLINE' | 'REVOKED';
}

export interface TeamResource {
  key: string;
  revision: number;
  uncertain: boolean;
  updatedAt: string;
  lock?: {
    leaseId: string;
    workerId: string;
    workItemId: string;
    expiresAt: string;
  };
}

export interface TeamLease {
  id: string;
  workerId: string;
  workItemId: string;
  epoch: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  baseResourceRevisions: Record<string, number>;
}

export interface TeamWorkItem {
  id: string;
  key: string;
  title: string;
  role: TeamRole;
  risk: ActionRisk;
  priority: number;
  dependsOn: string[];
  resources: string[];
  allowedCapabilities: string[];
  state: TeamWorkState;
  attempts: number;
  lease?: TeamLease;
  result?: {
    summary: string;
    evidence: Array<{ kind: string; status: 'pass' | 'fail' | 'info'; message: string }>;
    verificationPassed?: boolean;
    worldObservationDigest?: string;
    completedAt: string;
    workerId: string;
  };
  failure?: { code: string; message: string; at: string };
}

export interface TeamBlackboardEntry {
  key: string;
  revision: number;
  value: unknown;
  workerId: string;
  updatedAt: string;
}

export interface TeamMission {
  version: 1;
  id: string;
  objective: string;
  state: TeamMissionState;
  epoch: number;
  budget: TeamBudget;
  workers: TeamWorker[];
  resources: TeamResource[];
  workItems: TeamWorkItem[];
  blackboard: TeamBlackboardEntry[];
  events: TeamEvent[];
  startedAt?: string;
  deadlineAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamEvent {
  seq: number;
  at: string;
  type: string;
  workerId?: string;
  workItemId?: string;
  data?: Record<string, unknown>;
}

export interface TeamWorkInput {
  key: string;
  title: string;
  role: TeamRole;
  risk?: ActionRisk;
  priority?: number;
  dependsOn?: string[];
  resources?: string[];
  allowedCapabilities?: string[];
}

const MAX_MISSION_BYTES = 8 * 1024 * 1024;
const MAX_WORK_ITEMS = 1000;
const MAX_WORKERS = 64;
const MAX_RESOURCES = 5000;
const MAX_EVENTS = 20_000;
const MAX_BLACKBOARD_ENTRIES = 2000;
const MAX_BLACKBOARD_VALUE_BYTES = 64 * 1024;
const STORE_OPTIONS = {
  maxBytes: MAX_MISSION_BYTES,
  errorCode: 'TEAM_STATE_CORRUPT',
  invalidMessage: 'Stored team mission is invalid.'
} as const;

export class TeamCoordinator {
  #store: TeamStore;

  constructor(stateDir: string) {
    this.#store = new TeamStore(stateDir);
  }

  async submit(input: {
    objective: string;
    workItems: TeamWorkInput[];
    budget?: Partial<TeamBudget>;
  }): Promise<TeamMission> {
    const objective = boundedText(input.objective, 16_384, 'objective');
    if (!Array.isArray(input.workItems) || input.workItems.length < 1 || input.workItems.length > MAX_WORK_ITEMS) {
      throw new OperatorError('TEAM_INPUT_INVALID', `workItems must contain 1-${MAX_WORK_ITEMS} entries.`);
    }
    const now = new Date().toISOString();
    const missionId = crypto.randomUUID();
    const keys = new Set<string>();
    const resources = new Set<string>();
    const workItems: TeamWorkItem[] = input.workItems.map((item, index) => {
      const key = boundedKey(item.key, `workItems[${index}].key`);
      if (keys.has(key)) throw new OperatorError('TEAM_INPUT_INVALID', `Duplicate work item key ${key}.`);
      keys.add(key);
      const itemResources = uniqueStrings(item.resources ?? [], MAX_RESOURCES, 1024, `workItems[${index}].resources`).map(normalizeResourceKey);
      for (const resource of itemResources) resources.add(resource);
      return {
        id: stableWorkItemId(missionId, key),
        key,
        title: boundedText(item.title, 16_384, `workItems[${index}].title`),
        role: validRole(item.role),
        risk: validRisk(item.risk ?? 'read'),
        priority: boundedInteger(item.priority ?? 0, -1000, 1000, `workItems[${index}].priority`),
        dependsOn: uniqueStrings(item.dependsOn ?? [], MAX_WORK_ITEMS, 128, `workItems[${index}].dependsOn`),
        resources: itemResources,
        allowedCapabilities: uniqueStrings(item.allowedCapabilities ?? [], 200, 256, `workItems[${index}].allowedCapabilities`).sort(),
        state: 'PENDING',
        attempts: 0
      };
    });
    for (const item of workItems) {
      for (const dependency of item.dependsOn) if (!keys.has(dependency) || dependency === item.key) {
        throw new OperatorError('TEAM_INPUT_INVALID', `Work item ${item.key} has invalid dependency ${dependency}.`);
      }
    }
    assertAcyclic(workItems);
    const verifierItems = workItems.filter((item) => item.role === 'verifier');
    if (verifierItems.length === 0) throw new OperatorError('TEAM_VERIFIER_REQUIRED', 'Stage-4 missions require at least one verifier work item.');
    const nonVerifierKeys = workItems.filter((item) => item.role !== 'verifier').map((item) => item.key);
    if (!verifierItems.some((item) => nonVerifierKeys.every((key) => transitivelyDependsOn(item.key, key, workItems)))) {
      throw new OperatorError('TEAM_VERIFIER_COVERAGE_INVALID', 'At least one verifier must transitively depend on every non-verifier work item.');
    }

    const budget = normalizeBudget(input.budget);
    const mission: TeamMission = {
      version: 1,
      id: missionId,
      objective,
      state: 'PENDING',
      epoch: 1,
      budget,
      workers: [],
      resources: [...resources].sort().map((key) => ({ key, revision: 0, uncertain: false, updatedAt: now })),
      workItems,
      blackboard: [],
      events: [],
      createdAt: now,
      updatedAt: now
    };
    appendEvent(mission, 'mission.submitted', undefined, undefined, { workItems: workItems.length, resources: resources.size });
    await this.#store.create(mission);
    return structuredClone(mission);
  }

  async inspect(missionId: string): Promise<TeamMission> {
    return await this.#store.get(missionId);
  }

  async list(limit = 100): Promise<Array<Pick<TeamMission, 'id' | 'objective' | 'state' | 'updatedAt'>>> {
    return await this.#store.list(limit);
  }

  async start(missionId: string): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      reapExpired(mission);
      if (mission.state === 'VERIFIED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') {
        throw new OperatorError('TEAM_TERMINAL', 'Terminal mission cannot be started.');
      }
      const now = Date.now();
      mission.state = 'RUNNING';
      mission.startedAt ??= new Date(now).toISOString();
      mission.deadlineAt = new Date(now + mission.budget.maxWallClockMs).toISOString();
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'mission.started');
      return mission;
    });
  }

  async pause(missionId: string): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      if (mission.state !== 'RUNNING' && mission.state !== 'BLOCKED') throw new OperatorError('TEAM_STATE_INVALID', 'Only running/blocked missions can be paused.');
      invalidateLiveLeases(mission, 'pause');
      mission.epoch += 1;
      mission.state = 'PAUSED';
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'mission.paused');
      return mission;
    });
  }

  async resume(missionId: string): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      if (mission.state !== 'PAUSED' && mission.state !== 'BLOCKED') throw new OperatorError('TEAM_STATE_INVALID', 'Only paused/blocked missions can be resumed.');
      if (mission.resources.some((resource) => resource.uncertain)) throw new OperatorError('TEAM_RECONCILIATION_REQUIRED', 'Uncertain resources must be reconciled before resume.');
      mission.state = 'RUNNING';
      mission.deadlineAt = new Date(Date.now() + mission.budget.maxWallClockMs).toISOString();
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'mission.resumed');
      return mission;
    });
  }

  async cancel(missionId: string): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      if (mission.state === 'VERIFIED' || mission.state === 'FAILED' || mission.state === 'CANCELLED') return mission;
      invalidateLiveLeases(mission, 'cancel');
      mission.epoch += 1;
      for (const item of mission.workItems) if (!['COMPLETED', 'FAILED'].includes(item.state)) item.state = 'CANCELLED';
      mission.state = 'CANCELLED';
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'mission.cancelled');
      return mission;
    });
  }

  async registerWorker(missionId: string, input: {
    workerId?: string;
    role: TeamRole;
    label: string;
    capabilities?: string[];
  }): Promise<{ mission: TeamMission; worker: TeamWorker }> {
    let worker!: TeamWorker;
    const mission = await this.#store.update(missionId, (current) => {
      reapExpired(current);
      const id = input.workerId === undefined ? crypto.randomUUID() : validUuid(input.workerId, 'workerId');
      const role = validRole(input.role);
      const now = new Date().toISOString();
      const existing = current.workers.find((candidate) => candidate.id === id);
      if (existing) {
        if (existing.state === 'REVOKED') throw new OperatorError('TEAM_WORKER_REVOKED', 'Revoked worker identity cannot be re-registered.');
        existing.role = role;
        existing.label = boundedText(input.label, 256, 'worker label');
        existing.capabilities = uniqueStrings(input.capabilities ?? [], 200, 256, 'worker capabilities').sort();
        existing.heartbeatAt = now;
        existing.state = 'ACTIVE';
        worker = existing;
      } else {
        if (current.workers.length >= Math.min(current.budget.maxWorkers, MAX_WORKERS)) throw new OperatorError('TEAM_WORKER_LIMIT', 'Mission worker limit reached.');
        worker = {
          id, role, label: boundedText(input.label, 256, 'worker label'),
          capabilities: uniqueStrings(input.capabilities ?? [], 200, 256, 'worker capabilities').sort(),
          registeredAt: now, heartbeatAt: now, state: 'ACTIVE'
        };
        current.workers.push(worker);
      }
      current.updatedAt = now;
      appendEvent(current, 'worker.registered', worker.id, undefined, { role: worker.role });
      return current;
    });
    return { mission, worker: structuredClone(worker) };
  }

  async heartbeat(missionId: string, input: { workerId: string; leaseId?: string }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      reapExpired(mission);
      const worker = requireWorker(mission, input.workerId);
      worker.heartbeatAt = new Date().toISOString();
      worker.state = 'ACTIVE';
      if (input.leaseId) {
        const leaseId = validUuid(input.leaseId, 'leaseId');
        const item = mission.workItems.find((candidate) => candidate.lease?.id === leaseId && candidate.lease.workerId === worker.id);
        if (!item?.lease) throw new OperatorError('TEAM_LEASE_LOST', 'Worker no longer owns the requested lease.');
        const expiresAt = new Date(Date.now() + mission.budget.leaseMs).toISOString();
        item.lease.heartbeatAt = worker.heartbeatAt;
        item.lease.expiresAt = expiresAt;
        for (const resourceKey of item.resources) {
          const resource = requireResource(mission, resourceKey);
          if (resource.lock?.leaseId !== leaseId) throw new OperatorError('TEAM_LEASE_LOST', 'Resource lock ownership changed.');
          resource.lock.expiresAt = expiresAt;
        }
      }
      mission.updatedAt = new Date().toISOString();
      return mission;
    });
  }

  async claim(missionId: string, input: { workerId: string }): Promise<{ mission: TeamMission; workItem?: TeamWorkItem }> {
    let claimed: TeamWorkItem | undefined;
    const mission = await this.#store.update(missionId, (current) => {
      reapExpired(current);
      if (!ensureMissionRunnable(current)) return current;
      const worker = requireWorker(current, input.workerId);
      if (worker.state !== 'ACTIVE') throw new OperatorError('TEAM_WORKER_OFFLINE', 'Worker is not active.');
      const liveLeases = current.workItems.filter((item) => item.state === 'LEASED' && item.lease && Date.parse(item.lease.expiresAt) > Date.now()).length;
      if (liveLeases >= current.budget.maxConcurrentLeases) return current;

      const completed = new Set(current.workItems.filter((item) => item.state === 'COMPLETED').map((item) => item.key));
      const candidates = current.workItems
        .filter((item) => item.state === 'PENDING')
        .filter((item) => item.role === worker.role || item.role === 'general' || worker.role === 'supervisor')
        .filter((item) => item.dependsOn.every((key) => completed.has(key)))
        .filter((item) => item.allowedCapabilities.every((capability) => worker.capabilities.includes(capability)))
        .filter((item) => item.resources.every((key) => {
          const resource = requireResource(current, key);
          return !resource.uncertain && !resource.lock;
        }))
        .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
      const item = candidates[0];
      if (!item) return current;
      if (item.attempts >= current.budget.maxAttemptsPerWorkItem) {
        item.state = 'FAILED';
        item.failure = { code: 'TEAM_ATTEMPT_BUDGET_EXHAUSTED', message: 'Work item exhausted attempt budget.', at: new Date().toISOString() };
        current.state = 'FAILED';
        appendEvent(current, 'work.failed', worker.id, item.id, { code: item.failure.code });
        return current;
      }
      item.attempts += 1;
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + current.budget.leaseMs).toISOString();
      const lease: TeamLease = {
        id: crypto.randomUUID(), workerId: worker.id, workItemId: item.id, epoch: current.epoch,
        acquiredAt: now, heartbeatAt: now, expiresAt,
        baseResourceRevisions: Object.fromEntries(item.resources.map((key) => [key, requireResource(current, key).revision]))
      };
      item.lease = lease;
      item.state = 'LEASED';
      for (const resourceKey of item.resources) {
        const resource = requireResource(current, resourceKey);
        resource.lock = { leaseId: lease.id, workerId: worker.id, workItemId: item.id, expiresAt };
      }
      current.updatedAt = now;
      worker.heartbeatAt = now;
      appendEvent(current, 'work.claimed', worker.id, item.id, { leaseId: lease.id, attempt: item.attempts });
      claimed = structuredClone(item);
      return current;
    });
    return { mission, ...(claimed ? { workItem: claimed } : {}) };
  }

  async putBlackboard(missionId: string, input: {
    workerId: string;
    key: string;
    value: unknown;
    expectedRevision?: number;
    workItemId?: string;
    leaseId?: string;
  }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      reapExpired(mission);
      const worker = requireWorker(mission, input.workerId);
      if (worker.role !== 'supervisor') {
        if (!input.workItemId || !input.leaseId) throw new OperatorError('TEAM_BLACKBOARD_LEASE_REQUIRED', 'Non-supervisor blackboard writes require an active work lease.');
        const item = requireWorkItem(mission, input.workItemId);
        requireLease(item, worker.id, input.leaseId, mission.epoch);
      }
      const key = boundedKey(input.key, 'blackboard key');
      const value = cloneBoundedJson(input.value, MAX_BLACKBOARD_VALUE_BYTES, 'blackboard value');
      const existing = mission.blackboard.find((entry) => entry.key === key);
      if (existing) {
        if (input.expectedRevision === undefined || input.expectedRevision !== existing.revision) {
          throw new OperatorError('TEAM_BLACKBOARD_CONFLICT', 'Blackboard entry revision changed; refresh before updating.');
        }
        existing.revision += 1;
        existing.value = value;
        existing.workerId = worker.id;
        existing.updatedAt = new Date().toISOString();
      } else {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new OperatorError('TEAM_BLACKBOARD_CONFLICT', 'New blackboard entry requires expectedRevision=0 or omission.');
        if (mission.blackboard.length >= MAX_BLACKBOARD_ENTRIES) throw new OperatorError('TEAM_BLACKBOARD_LIMIT', 'Mission blackboard entry limit reached.');
        mission.blackboard.push({ key, revision: 1, value, workerId: worker.id, updatedAt: new Date().toISOString() });
        mission.blackboard.sort((a, b) => a.key.localeCompare(b.key));
      }
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'blackboard.updated', worker.id, input.workItemId, { key, revision: mission.blackboard.find((entry) => entry.key === key)!.revision });
      return mission;
    });
  }

  async authorizeExecution(missionId: string, input: {
    workerId: string;
    workItemId: string;
    leaseId: string;
    capability: string;
    risk: ActionRisk;
    resourceKeys?: string[];
  }): Promise<{ mission: TeamMission; workItem: TeamWorkItem }> {
    let authorized: TeamWorkItem | undefined;
    let gateError: { code: string; message: string } | undefined;
    const mission = await this.#store.update(missionId, (current) => {
      reapExpired(current);
      if (!ensureMissionRunnable(current)) {
        gateError = current.state === 'BLOCKED'
          ? { code: 'TEAM_RECONCILIATION_REQUIRED', message: 'Mission has uncertain resources that require reconciliation.' }
          : { code: 'TEAM_TIMEOUT', message: 'Mission exceeded its wall-clock budget.' };
        return current;
      }
      const worker = requireWorker(current, input.workerId);
      const item = requireWorkItem(current, input.workItemId);
      const lease = requireLease(item, worker.id, input.leaseId, current.epoch);
      const capability = boundedText(input.capability, 256, 'capability');
      if (!item.allowedCapabilities.includes(capability) || !worker.capabilities.includes(capability)) {
        throw new OperatorError('TEAM_CAPABILITY_DENIED', `Capability ${capability} is not authorized for this worker/work item.`);
      }
      const risk = validRisk(input.risk);
      if (risk !== 'read' && risk !== item.risk) {
        throw new OperatorError('TEAM_RISK_DENIED', `Work item declared risk ${item.risk} and cannot execute ${risk} action.`);
      }
      const requestedResources = uniqueStrings(input.resourceKeys ?? [], MAX_RESOURCES, 1024, 'execution resourceKeys').map(normalizeResourceKey);
      for (const key of requestedResources) {
        if (!item.resources.includes(key)) throw new OperatorError('TEAM_RESOURCE_DENIED', `Resource ${key} is not assigned to this work item.`);
        const resource = requireResource(current, key);
        if (resource.uncertain || resource.lock?.leaseId !== lease.id) throw new OperatorError('TEAM_ARTIFACT_CONFLICT', `Resource ${key} is not safely owned by this lease.`);
      }
      if (risk !== 'read' && item.resources.length > 0 && requestedResources.length === 0) {
        throw new OperatorError('TEAM_RESOURCE_REQUIRED', 'Mutating team actions with declared resources must bind at least one resource key.');
      }
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + current.budget.leaseMs).toISOString();
      lease.heartbeatAt = now;
      lease.expiresAt = expiresAt;
      worker.heartbeatAt = now;
      for (const resourceKey of item.resources) {
        const resource = requireResource(current, resourceKey);
        if (resource.lock?.leaseId === lease.id) resource.lock.expiresAt = expiresAt;
      }
      current.updatedAt = now;
      appendEvent(current, 'work.action_authorized', worker.id, item.id, { capability, risk, resources: requestedResources.length });
      authorized = structuredClone(item);
      return current;
    });
    if (gateError) throw new OperatorError(gateError.code, gateError.message);
    if (!authorized) throw new OperatorError('TEAM_EXECUTION_DENIED', 'Work execution authorization was not granted.');
    return { mission, workItem: authorized };
  }

  async complete(missionId: string, input: {
    workerId: string;
    workItemId: string;
    leaseId: string;
    summary: string;
    evidence?: Array<{ kind: string; status: 'pass' | 'fail' | 'info'; message: string }>;
    verificationPassed?: boolean;
    worldObservationDigest?: string;
  }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      reapExpired(mission);
      const worker = requireWorker(mission, input.workerId);
      const item = requireWorkItem(mission, input.workItemId);
      const lease = requireLease(item, worker.id, input.leaseId, mission.epoch);
      for (const [resourceKey, baseRevision] of Object.entries(lease.baseResourceRevisions)) {
        const resource = requireResource(mission, resourceKey);
        if (resource.uncertain || resource.lock?.leaseId !== lease.id || resource.revision !== baseRevision) {
          throw new OperatorError('TEAM_ARTIFACT_CONFLICT', `Resource ${resourceKey} changed or lost lock ownership during work.`);
        }
      }
      if (item.role === 'verifier' && input.verificationPassed !== true) {
        throw new OperatorError('TEAM_VERIFICATION_REQUIRED', 'Verifier work can complete only with verificationPassed=true.');
      }
      if (input.worldObservationDigest !== undefined) {
        if (item.role !== 'verifier' || input.verificationPassed !== true) {
          throw new OperatorError('TEAM_WORLD_OBSERVATION_DENIED', 'Only a passing verifier may commit world observations.');
        }
        if (!/^[0-9a-f]{64}$/i.test(input.worldObservationDigest)) {
          throw new OperatorError('TEAM_INPUT_INVALID', 'worldObservationDigest must be SHA-256.');
        }
      }
      const now = new Date().toISOString();
      item.result = {
        summary: boundedText(input.summary, 64 * 1024, 'completion summary'),
        evidence: validateEvidence(input.evidence ?? []),
        ...(item.role === 'verifier' ? { verificationPassed: true } : {}),
        ...(input.worldObservationDigest ? { worldObservationDigest: input.worldObservationDigest.toLowerCase() } : {}),
        completedAt: now,
        workerId: worker.id
      };
      item.state = 'COMPLETED';
      delete item.lease;
      for (const resourceKey of item.resources) {
        const resource = requireResource(mission, resourceKey);
        if (item.risk !== 'read') resource.revision += 1;
        delete resource.lock;
        resource.updatedAt = now;
      }
      worker.heartbeatAt = now;
      mission.updatedAt = now;
      appendEvent(mission, 'work.completed', worker.id, item.id, { risk: item.risk });
      finalizeIfVerified(mission);
      return mission;
    });
  }

  async fail(missionId: string, input: {
    workerId: string;
    workItemId: string;
    leaseId: string;
    code: string;
    message: string;
    sideEffectState: SideEffectState;
    retryable?: boolean;
  }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      reapExpired(mission);
      const worker = requireWorker(mission, input.workerId);
      const item = requireWorkItem(mission, input.workItemId);
      const lease = requireLease(item, worker.id, input.leaseId, mission.epoch);
      const now = new Date().toISOString();
      const code = boundedKey(input.code, 'failure code');
      const message = boundedText(input.message, 64 * 1024, 'failure message');
      if (!['none', 'known', 'uncertain'].includes(input.sideEffectState)) throw new OperatorError('TEAM_INPUT_INVALID', 'sideEffectState must be none, known, or uncertain.');
      const uncertain = input.sideEffectState === 'uncertain';
      for (const resourceKey of item.resources) {
        const resource = requireResource(mission, resourceKey);
        if (resource.lock?.leaseId === lease.id) delete resource.lock;
        if (uncertain) resource.uncertain = true;
        if (sideEffectState === 'known' && item.risk !== 'read') resource.revision += 1;
        resource.updatedAt = now;
      }
      delete item.lease;
      item.failure = { code, message, at: now };
      const safeRetry = input.retryable === true && sideEffectState === 'none' && item.attempts < mission.budget.maxAttemptsPerWorkItem;
      item.state = uncertain ? 'NEEDS_RECONCILIATION' : safeRetry ? 'PENDING' : 'FAILED';
      if (uncertain) mission.state = 'BLOCKED';
      else if (!safeRetry) mission.state = 'FAILED';
      mission.updatedAt = now;
      appendEvent(mission, 'work.failed', worker.id, item.id, { code, sideEffectState, retrying: safeRetry });
      return mission;
    });
  }

  async reconcile(missionId: string, input: {
    workerId: string;
    workItemId: string;
    resolution: 'completed' | 'retry' | 'failed';
    summary: string;
    evidence?: Array<{ kind: string; status: 'pass' | 'fail' | 'info'; message: string }>;
  }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      const worker = requireWorker(mission, input.workerId);
      if (!['supervisor', 'verifier'].includes(worker.role)) throw new OperatorError('TEAM_RECONCILIATION_DENIED', 'Only supervisor/verifier workers may reconcile uncertain work.');
      const item = requireWorkItem(mission, input.workItemId);
      if (item.state !== 'NEEDS_RECONCILIATION') throw new OperatorError('TEAM_RECONCILIATION_INVALID', 'Work item is not awaiting reconciliation.');
      const now = new Date().toISOString();
      for (const resourceKey of item.resources) {
        const resource = requireResource(mission, resourceKey);
        resource.uncertain = false;
        resource.revision += 1;
        delete resource.lock;
        resource.updatedAt = now;
      }
      if (!['completed', 'retry', 'failed'].includes(input.resolution)) throw new OperatorError('TEAM_INPUT_INVALID', 'Reconciliation resolution is invalid.');
      const evidence = validateEvidence(input.evidence ?? []);
      if (input.resolution === 'completed') {
        item.state = 'COMPLETED';
        item.result = {
          summary: boundedText(input.summary, 64 * 1024, 'reconciliation summary'),
          evidence,
          completedAt: now,
          workerId: worker.id
        };
      } else if (input.resolution === 'retry') {
        if (item.attempts >= mission.budget.maxAttemptsPerWorkItem) throw new OperatorError('TEAM_ATTEMPT_BUDGET_EXHAUSTED', 'Cannot retry after attempt budget is exhausted.');
        item.state = 'PENDING';
        delete item.failure;
      } else {
        item.state = 'FAILED';
        item.failure = { code: 'TEAM_RECONCILIATION_FAILED', message: boundedText(input.summary, 64 * 1024, 'reconciliation summary'), at: now };
        mission.state = 'FAILED';
      }
      mission.updatedAt = now;
      appendEvent(mission, 'work.reconciled', worker.id, item.id, { resolution: input.resolution });
      if (mission.state === 'BLOCKED' && !mission.resources.some((resource) => resource.uncertain)) mission.state = 'RUNNING';
      finalizeIfVerified(mission);
      return mission;
    });
  }

  async revokeWorker(missionId: string, input: { workerId: string }): Promise<TeamMission> {
    return await this.#store.update(missionId, (mission) => {
      const worker = requireWorker(mission, input.workerId);
      worker.state = 'REVOKED';
      worker.heartbeatAt = new Date().toISOString();
      for (const item of mission.workItems.filter((candidate) => candidate.lease?.workerId === worker.id)) {
        expireLease(mission, item, 'worker_revoked');
      }
      mission.updatedAt = new Date().toISOString();
      appendEvent(mission, 'worker.revoked', worker.id);
      return mission;
    });
  }
}

class TeamStore {
  #dir: string;
  #lockDir: string;

  constructor(stateDir: string) {
    const root = path.resolve(stateDir);
    this.#dir = path.join(root, 'team-missions');
    this.#lockDir = path.join(root, 'team-mission-locks');
  }

  async create(mission: TeamMission): Promise<void> {
    await this.#init();
    validateMission(mission);
    await createDurableStateBytes(this.#file(mission.id), Buffer.from(JSON.stringify(mission, null, 2), 'utf8'), STORE_OPTIONS);
  }

  async get(idInput: string): Promise<TeamMission> {
    await this.#init();
    const id = validUuid(idInput, 'missionId');
    try {
      return validateMission(JSON.parse(await readDurableStateText(this.#file(id), STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('TEAM_NOT_FOUND', `Mission ${id} was not found.`);
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('TEAM_STATE_CORRUPT', 'Stored team mission could not be read.');
    }
  }

  async update<T extends TeamMission>(idInput: string, mutate: (mission: TeamMission) => T): Promise<T> {
    const id = validUuid(idInput, 'missionId');
    await this.#init();
    const release = await this.#acquire(id);
    try {
      const mission = await this.get(id);
      const updated = mutate(mission);
      validateMission(updated);
      await writeDurableStateText(this.#file(id), JSON.stringify(updated, null, 2), STORE_OPTIONS);
      return structuredClone(updated);
    } finally {
      await release();
    }
  }

  async list(limitInput = 100): Promise<Array<Pick<TeamMission, 'id' | 'objective' | 'state' | 'updatedAt'>>> {
    await this.#init();
    const limit = boundedInteger(limitInput, 1, 500, 'limit');
    const names = (await fs.readdir(this.#dir)).filter((name) => name.endsWith('.json')).sort();
    const missions: TeamMission[] = [];
    for (const name of names.slice(0, limit)) {
      const id = validUuid(name.slice(0, -5), 'missionId');
      missions.push(await this.get(id));
    }
    return missions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, objective, state, updatedAt }) => ({ id, objective, state, updatedAt }));
  }

  async #init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.#lockDir, { recursive: true, mode: 0o700 });
    for (const dir of [this.#dir, this.#lockDir]) {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OperatorError('TEAM_STATE_CORRUPT', 'Team state directories must be real directories.');
    }
  }

  #file(id: string): string { return path.join(this.#dir, `${validUuid(id, 'missionId')}.json`); }

  async #acquire(id: string): Promise<() => Promise<void>> {
    const file = path.join(this.#lockDir, `${id}.lock`);
    const owner = { id: crypto.randomUUID(), pid: process.pid, at: new Date().toISOString() };
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(owner), 'utf8');
        await handle.sync();
        await handle.close();
        return async () => {
          try {
            const current = JSON.parse(await fs.readFile(file, 'utf8')) as { id?: unknown };
            if (current.id !== owner.id) throw new OperatorError('TEAM_LOCK_LOST', 'Team mission lock ownership changed.');
            await fs.rm(file);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('TEAM_LOCK_LOST', 'Team mission lock disappeared.');
            throw error;
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      try {
        const current = JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown };
        const pid = Number(current.pid);
        if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) {
          await fs.rm(file, { force: true });
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new OperatorError('TEAM_LOCK_BUSY', 'Team mission is busy with another coordinator.');
  }
}

function normalizeBudget(input: Partial<TeamBudget> | undefined): TeamBudget {
  return {
    maxWorkers: boundedInteger(input?.maxWorkers ?? 16, 1, MAX_WORKERS, 'maxWorkers'),
    maxConcurrentLeases: boundedInteger(input?.maxConcurrentLeases ?? 8, 1, 32, 'maxConcurrentLeases'),
    maxAttemptsPerWorkItem: boundedInteger(input?.maxAttemptsPerWorkItem ?? 3, 1, 10, 'maxAttemptsPerWorkItem'),
    maxWallClockMs: boundedInteger(input?.maxWallClockMs ?? 4 * 60 * 60_000, 60_000, 24 * 60 * 60_000, 'maxWallClockMs'),
    leaseMs: boundedInteger(input?.leaseMs ?? 5 * 60_000, 10_000, 30 * 60_000, 'leaseMs')
  };
}

function ensureMissionRunnable(mission: TeamMission): boolean {
  if (mission.state !== 'RUNNING') throw new OperatorError('TEAM_STATE_INVALID', 'Mission is not running.');
  if (mission.deadlineAt && Date.now() >= Date.parse(mission.deadlineAt)) {
    mission.state = 'FAILED';
    mission.updatedAt = new Date().toISOString();
    appendEvent(mission, 'mission.deadline_exceeded');
    return false;
  }
  if (mission.resources.some((resource) => resource.uncertain)) {
    mission.state = 'BLOCKED';
    mission.updatedAt = new Date().toISOString();
    appendEvent(mission, 'mission.reconciliation_required');
    return false;
  }
  return true;
}

function reapExpired(mission: TeamMission): void {
  const now = Date.now();
  for (const worker of mission.workers) {
    if (worker.state === 'ACTIVE' && now - Date.parse(worker.heartbeatAt) > Math.max(mission.budget.leaseMs * 2, 60_000)) worker.state = 'OFFLINE';
  }
  for (const item of mission.workItems) {
    if (item.state === 'LEASED' && item.lease && Date.parse(item.lease.expiresAt) <= now) expireLease(mission, item, 'lease_expired');
  }
  if (mission.resources.some((resource) => resource.uncertain) && !['FAILED', 'CANCELLED', 'VERIFIED'].includes(mission.state)) mission.state = 'BLOCKED';
}

function expireLease(mission: TeamMission, item: TeamWorkItem, reason: string): void {
  const lease = item.lease;
  if (!lease) return;
  for (const resourceKey of item.resources) {
    const resource = requireResource(mission, resourceKey);
    if (resource.lock?.leaseId === lease.id) delete resource.lock;
    if (item.risk !== 'read') resource.uncertain = true;
    resource.updatedAt = new Date().toISOString();
  }
  delete item.lease;
  item.state = item.risk === 'read' ? 'PENDING' : 'NEEDS_RECONCILIATION';
  appendEvent(mission, 'work.lease_expired', lease.workerId, item.id, { reason, risk: item.risk });
}

function invalidateLiveLeases(mission: TeamMission, reason: string): void {
  for (const item of mission.workItems) if (item.lease) expireLease(mission, item, reason);
}

function finalizeIfVerified(mission: TeamMission): void {
  if (mission.workItems.some((item) => ['FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION', 'LEASED', 'PENDING', 'BLOCKED'].includes(item.state))) return;
  const verifier = mission.workItems.find((item) => item.role === 'verifier' && item.state === 'COMPLETED' && item.result?.verificationPassed === true);
  if (!verifier) {
    mission.state = 'BLOCKED';
    appendEvent(mission, 'mission.verifier_required');
    return;
  }
  mission.state = 'VERIFIED';
  mission.updatedAt = new Date().toISOString();
  appendEvent(mission, 'mission.verified', verifier.result?.workerId, verifier.id);
}

function requireWorker(mission: TeamMission, workerIdInput: string): TeamWorker {
  const workerId = validUuid(workerIdInput, 'workerId');
  const worker = mission.workers.find((candidate) => candidate.id === workerId);
  if (!worker) throw new OperatorError('TEAM_WORKER_NOT_FOUND', 'Worker is not registered with this mission.');
  if (worker.state === 'REVOKED') throw new OperatorError('TEAM_WORKER_REVOKED', 'Worker is revoked.');
  return worker;
}

function requireWorkItem(mission: TeamMission, idInput: string): TeamWorkItem {
  const id = validUuid(idInput, 'workItemId');
  const item = mission.workItems.find((candidate) => candidate.id === id);
  if (!item) throw new OperatorError('TEAM_WORK_NOT_FOUND', 'Work item was not found.');
  return item;
}

function requireLease(item: TeamWorkItem, workerId: string, leaseIdInput: string, epoch: number): TeamLease {
  const leaseId = validUuid(leaseIdInput, 'leaseId');
  const lease = item.lease;
  if (!lease || item.state !== 'LEASED' || lease.id !== leaseId || lease.workerId !== workerId || lease.epoch !== epoch) {
    throw new OperatorError('TEAM_LEASE_LOST', 'Work lease is no longer owned by this worker.');
  }
  if (Date.parse(lease.expiresAt) <= Date.now()) throw new OperatorError('TEAM_LEASE_EXPIRED', 'Work lease expired before completion.');
  return lease;
}

function requireResource(mission: TeamMission, key: string): TeamResource {
  const resource = mission.resources.find((candidate) => candidate.key === key);
  if (!resource) throw new OperatorError('TEAM_RESOURCE_NOT_FOUND', `Resource ${key} is not declared by this mission.`);
  return resource;
}

function appendEvent(mission: TeamMission, type: string, workerId?: string, workItemId?: string, data?: Record<string, unknown>): void {
  const event: TeamEvent = {
    seq: (mission.events.at(-1)?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    type: boundedKey(type, 'event type'),
    ...(workerId ? { workerId } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(data ? { data: structuredClone(data) } : {})
  };
  mission.events.push(event);
  if (mission.events.length > MAX_EVENTS) mission.events.splice(0, mission.events.length - MAX_EVENTS);
}

function validateMission(input: unknown): TeamMission {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission must be an object.');
  const mission = input as TeamMission;
  if (mission.version !== 1) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission version is invalid.');
  validUuid(mission.id, 'mission id');
  boundedText(mission.objective, 16_384, 'mission objective');
  if (!['PENDING', 'RUNNING', 'PAUSED', 'BLOCKED', 'FAILED', 'CANCELLED', 'VERIFIED'].includes(mission.state)) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission state is invalid.');
  boundedInteger(mission.epoch, 1, Number.MAX_SAFE_INTEGER, 'mission epoch');
  normalizeBudget(mission.budget);
  if (!Array.isArray(mission.workers) || mission.workers.length > MAX_WORKERS) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission workers are invalid.');
  if (!Array.isArray(mission.resources) || mission.resources.length > MAX_RESOURCES) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission resources are invalid.');
  if (!Array.isArray(mission.workItems) || mission.workItems.length > MAX_WORK_ITEMS) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission work items are invalid.');
  if (!Array.isArray(mission.blackboard) || mission.blackboard.length > MAX_BLACKBOARD_ENTRIES) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission blackboard is invalid.');
  for (const entry of mission.blackboard) {
    boundedKey(entry.key, 'blackboard key');
    boundedInteger(entry.revision, 1, Number.MAX_SAFE_INTEGER, 'blackboard revision');
    validUuid(entry.workerId, 'blackboard workerId');
    cloneBoundedJson(entry.value, MAX_BLACKBOARD_VALUE_BYTES, 'blackboard value');
  }
  if (!Array.isArray(mission.events) || mission.events.length > MAX_EVENTS) throw new OperatorError('TEAM_STATE_CORRUPT', 'Mission events are invalid.');
  return mission;
}

function validateEvidence(input: Array<{ kind: string; status: 'pass' | 'fail' | 'info'; message: string }>): Array<{ kind: string; status: 'pass' | 'fail' | 'info'; message: string }> {
  if (input.length > 1000) throw new OperatorError('TEAM_INPUT_INVALID', 'Evidence is limited to 1000 entries.');
  return input.map((entry, index) => {
    if (!['pass', 'fail', 'info'].includes(entry.status)) throw new OperatorError('TEAM_INPUT_INVALID', `Evidence ${index} status is invalid.`);
    return {
      kind: boundedKey(entry.kind, `evidence[${index}].kind`),
      status: entry.status,
      message: boundedText(entry.message, 64 * 1024, `evidence[${index}].message`)
    };
  });
}

function normalizeResourceKey(value: string): string {
  const key = value.trim().replace(/\\/g, '/');
  if (!key || key.length > 1024 || key.includes('\0') || key.includes('..')) throw new OperatorError('TEAM_INPUT_INVALID', 'Resource key is invalid.');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function stableWorkItemId(missionId: string, key: string): string {
  const digest = crypto.createHash('sha256').update(missionId).update('\0').update(key).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertAcyclic(items: TeamWorkItem[]): void {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new OperatorError('TEAM_INPUT_INVALID', 'Work dependency graph contains a cycle.');
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const item of items) visit(item.key);
}

function transitivelyDependsOn(sourceKey: string, targetKey: string, items: TeamWorkItem[]): boolean {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      if (dependency === targetKey || visit(dependency)) return true;
    }
    return false;
  };
  return visit(sourceKey);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function validRole(input: unknown): TeamRole {
  const value = String(input ?? '') as TeamRole;
  if (!['supervisor', 'planner', 'coder', 'tester', 'browser', 'ui', 'verifier', 'general'].includes(value)) throw new OperatorError('TEAM_INPUT_INVALID', 'Worker role is invalid.');
  return value;
}

function validRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(value)) throw new OperatorError('TEAM_INPUT_INVALID', 'Work item risk is invalid.');
  return value;
}

function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('TEAM_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}

function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('TEAM_INPUT_INVALID', `${label} is invalid.`);
  return input;
}

function boundedKey(input: unknown, label: string): string {
  const value = boundedText(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('TEAM_INPUT_INVALID', `${label} has invalid characters.`);
  return value;
}

function uniqueStrings(input: unknown[], maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('TEAM_INPUT_INVALID', `${label} has too many entries.`);
  const values = input.map((value, index) => boundedText(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('TEAM_INPUT_INVALID', `${label} contains duplicates.`);
  return values;
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('TEAM_INPUT_INVALID', `${label} is invalid.`);
  return value;
}


function cloneBoundedJson(value: unknown, maxBytes: number, label: string): unknown {
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new OperatorError('TEAM_INPUT_INVALID', `${label} must be JSON serializable.`); }
  if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) throw new OperatorError('TEAM_INPUT_INVALID', `${label} exceeds the bounded JSON size.`);
  return JSON.parse(text);
}
