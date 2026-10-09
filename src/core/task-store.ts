import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskActionRecord, TaskCapsule, TaskExecution, TaskNode, TaskObservationSummary, TaskRejectedDecision } from './task.ts';
import { validIntentBinding } from './intent-registry.ts';
import type { EpistemicStatus, Evidence, TaskState } from './types.ts';
import type { PlannerEventDecision, PlannerEventKind, TaskPlannerEvent } from './task-planner-event.ts';
import { normalizeDurableTaskPlan } from './task-plan.ts';
import { OperatorError } from './errors.ts';
import { createDurableStateBytes, readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { validateRecoveryShadowRecommendation } from './adaptive-recovery-shadow.ts';
import { validateStrategyShadowAssessment } from './adaptive-strategy-shadow.ts';
import {
  currentProcessInstance,
  observeProcessInstance,
  observerFromLegacyInspector,
  processInstanceDefinitelyStale,
  sameProcessInstance,
  type ProcessInstanceIdentity,
  type ProcessInstanceInspector,
  type ProcessInstanceObserver,
  validProcessInstance
} from './process-instance.ts';

const MAX_TASK_BYTES = 8 * 1024 * 1024;
const MAX_LIST = 500;
const MAX_NODES = 5000;
const MAX_EVIDENCE = 10_000;
const MAX_FAILURES = 5000;
const MAX_SCOPE_ITEMS = 1000;
const MAX_CONDITIONS = 1000;
const TASK_OPTIONS = {
  maxBytes: MAX_TASK_BYTES,
  errorCode: 'TASK_STATE_CORRUPT',
  invalidMessage: 'Stored task capsule is invalid.'
} as const;
const TASK_STATES = new Set<TaskState>(['PENDING', 'RUNNING', 'PAUSED', 'CANCELLED', 'BLOCKED', 'FAILED', 'VERIFIED', 'SKIPPED']);
const MAX_ACTION_RECORDS = 5000;
const MAX_REJECTED_DECISIONS = 100;
const MAX_PROGRESS_PROOFS = 1000;
const LEASE_OPTIONS = {
  maxBytes: 16 * 1024,
  errorCode: 'TASK_LEASE_CORRUPT',
  invalidMessage: 'Stored task execution lease is invalid.'
} as const;

type TaskLeaseRecord = {
  version: 2;
  taskId: string;
  ownerId: string;
  pid: number;
  processInstance: ProcessInstanceIdentity;
  acquiredAt: string;
};
type LegacyTaskLeaseRecord = Omit<TaskLeaseRecord, 'version' | 'processInstance'> & { version: 1 };
type StoredTaskLeaseRecord = TaskLeaseRecord | LegacyTaskLeaseRecord;

export interface TaskExecutionLease {
  readonly taskId: string;
  readonly ownerId: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export class TaskStore {
  #dir: string;
  #leaseDir: string;
  #observeProcessInstance: ProcessInstanceObserver;
  #processInstance?: ProcessInstanceIdentity;

  constructor(stateDir: string, options: {
    observeProcessInstance?: ProcessInstanceObserver;
    /** @deprecated Legacy identity-only seam. A null result is UNKNOWN, never confirmed dead. */
    inspectProcessInstance?: ProcessInstanceInspector;
    processInstance?: ProcessInstanceIdentity;
  } = {}) {
    const root = path.resolve(stateDir);
    this.#dir = path.join(root, 'tasks');
    this.#leaseDir = path.join(root, 'task-leases');
    this.#observeProcessInstance = options.observeProcessInstance
      ?? (options.inspectProcessInstance ? observerFromLegacyInspector(options.inspectProcessInstance) : observeProcessInstance);
    this.#processInstance = options.processInstance;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperatorError('TASK_STATE_CORRUPT', 'Task state directory must be a real directory, not a link or special file.');
    }
  }

  async put(taskInput: TaskCapsule): Promise<void> {
    await this.init();
    const task = validateTaskCapsule(taskInput);
    const file = this.#file(task.id);
    await writeDurableStateText(file, JSON.stringify(task, null, 2), TASK_OPTIONS);
  }

  async create(taskInput: TaskCapsule): Promise<void> {
    await this.init();
    const task = validateTaskCapsule(taskInput);
    const file = this.#file(task.id);
    await createDurableStateBytes(file, Buffer.from(JSON.stringify(task, null, 2), 'utf8'), TASK_OPTIONS);
  }

  async get(taskIdInput: string): Promise<TaskCapsule> {
    await this.init();
    const taskId = validTaskId(taskIdInput);
    try {
      return parseStoredTask(await readDurableStateText(this.#file(taskId), TASK_OPTIONS), taskId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('TASK_NOT_FOUND', `Task ${taskId} was not found.`);
      }
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('TASK_STATE_CORRUPT', `Stored task ${taskId} could not be read.`, { details: { cause: String(error) } });
    }
  }

  async list(limitInput = 100): Promise<Array<Pick<TaskCapsule, 'id' | 'userObjective' | 'state' | 'updatedAt'>>> {
    await this.init();
    const parsedLimit = Number(limitInput);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIST) : 100;
    const entries = (await fs.readdir(this.#dir))
      .filter((name) => name.endsWith('.json'))
      .sort();
    const tasks: TaskCapsule[] = [];
    for (const name of entries) {
      const candidateId = storedTaskIdFromFilename(name);
      const task = parseStoredTask(
        await readDurableStateText(path.join(this.#dir, name), TASK_OPTIONS),
        candidateId
      );
      tasks.push(task);
    }
    return tasks
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ id, userObjective, state, updatedAt }) => ({ id, userObjective, state, updatedAt }));
  }

  async delete(taskIdInput: string): Promise<void> {
    await this.init();
    const taskId = validTaskId(taskIdInput);
    await fs.rm(this.#file(taskId), { force: true });
  }

  async acquireExecutionLease(taskIdInput: string): Promise<TaskExecutionLease> {
    const taskId = validTaskId(taskIdInput);
    await this.#initLeaseDir();
    const leasePath = path.join(this.#leaseDir, `${taskId}.json`);
    const processInstance = this.#processInstance ?? await currentProcessInstance();
    const record: TaskLeaseRecord = {
      version: 2,
      taskId,
      ownerId: crypto.randomUUID(),
      pid: processInstance.pid,
      processInstance,
      acquiredAt: new Date().toISOString()
    };
    const serialized = Buffer.from(JSON.stringify(record), 'utf8');
    // A stale-owner observation must not authorize renaming a new owner's
    // lease after a concurrent contender has already reclaimed the old one.
    // Serialize admission and reclamation across independent process instances.
    return await withDurableStateLock(leasePath, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await createDurableStateBytes(leasePath, serialized, LEASE_OPTIONS);
        return taskExecutionLease(leasePath, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      let existing: StoredTaskLeaseRecord;
      try { existing = await readTaskLease(leasePath, taskId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const observation = await this.#observeProcessInstance(existing.pid);
      if (!processInstanceDefinitelyStale(existing.version === 2 ? existing.processInstance : undefined, observation)) {
        throw new OperatorError('TASK_ALREADY_RUNNING', `Task ${taskId} is already owned or process ownership cannot be safely disproven.`, {
          details: { acquiredAt: existing.acquiredAt, liveness: observation.status }
        });
      }
      const stale = `${leasePath}.${crypto.randomUUID()}.stale`;
      try {
        await fs.rename(leasePath, stale);
        await fs.rm(stale, { force: true });
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    throw new OperatorError('TASK_ALREADY_RUNNING', `Task ${taskId} execution ownership changed concurrently.`);
    });
  }

  #file(taskId: string): string {
    return path.join(this.#dir, `${validTaskId(taskId)}.json`);
  }

  async #initLeaseDir(): Promise<void> {
    await fs.mkdir(this.#leaseDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#leaseDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperatorError('TASK_LEASE_CORRUPT', 'Task lease directory must be a real directory, not a link or special file.');
    }
  }
}

function taskExecutionLease(leasePath: string, expected: TaskLeaseRecord): TaskExecutionLease {
  let released = false;
  const assertOwned = async (): Promise<void> => {
    if (released) throw new OperatorError('TASK_LEASE_LOST', 'Task execution lease has already been released.');
    const current = await readTaskLease(leasePath, expected.taskId).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OperatorError('TASK_LEASE_LOST', 'Task execution lease no longer exists.');
      throw error;
    });
    if (current.version !== 2 || current.ownerId !== expected.ownerId || current.pid !== expected.pid || !sameProcessInstance(expected.processInstance, current.processInstance)) {
      throw new OperatorError('TASK_LEASE_LOST', 'Task execution lease ownership changed.');
    }
  };
  return {
    taskId: expected.taskId,
    ownerId: expected.ownerId,
    assertOwned,
    async release(): Promise<void> {
      if (released) return;
      await withDurableStateLock(leasePath, async () => {
        if (released) return;
        await assertOwned();
        await fs.rm(leasePath);
        await syncLeaseDirectory(path.dirname(leasePath));
        released = true;
      });
    }
  };
}

async function readTaskLease(file: string, expectedTaskId: string): Promise<StoredTaskLeaseRecord> {
  let raw: unknown;
  try { raw = JSON.parse(await readDurableStateText(file, LEASE_OPTIONS)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    if (error instanceof OperatorError) throw error;
    throw new OperatorError('TASK_LEASE_CORRUPT', 'Stored task execution lease is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OperatorError('TASK_LEASE_CORRUPT', 'Stored task execution lease must be an object.');
  const value = raw as Record<string, unknown>;
  if (![1, 2].includes(Number(value.version)) || validLeaseId(value.taskId, 'taskId') !== expectedTaskId) throw new OperatorError('TASK_LEASE_CORRUPT', 'Stored task execution lease identity is invalid.');
  const ownerId = validLeaseId(value.ownerId, 'ownerId');
  const pid = Number(value.pid);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) throw new OperatorError('TASK_LEASE_CORRUPT', 'Stored task execution lease PID is invalid.');
  const acquiredAt = validIso(value.acquiredAt, 'lease acquiredAt');
  if (value.version === 1) return { version: 1, taskId: expectedTaskId, ownerId, pid, acquiredAt };
  const processInstance = validProcessInstance(value.processInstance);
  if (!processInstance || processInstance.pid !== pid) throw new OperatorError('TASK_LEASE_CORRUPT', 'Stored task execution lease process identity is invalid.');
  return { version: 2, taskId: expectedTaskId, ownerId, pid, processInstance, acquiredAt };
}

function validLeaseId(input: unknown, label: string): string {
  try { return validTaskId(String(input ?? '')); }
  catch { throw new OperatorError('TASK_LEASE_CORRUPT', `Stored task execution lease ${label} is invalid.`); }
}

async function syncLeaseDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseStoredTask(text: string, expectedTaskId: string): TaskCapsule {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw corrupt('Stored task capsule is not valid JSON.');
  }

  let task: TaskCapsule;
  try {
    task = validateTaskCapsule(decoded);
  } catch (error) {
    if (error instanceof OperatorError && error.code === 'INVALID_TASK_ID') {
      throw corrupt('Stored task capsule contains an invalid task or node id.');
    }
    throw error;
  }
  if (task.id !== expectedTaskId) throw corrupt('Stored task ID does not match its state filename.');
  return task;
}

function storedTaskIdFromFilename(name: string): string {
  try {
    return validTaskId(name.slice(0, -'.json'.length));
  } catch (error) {
    if (error instanceof OperatorError && error.code === 'INVALID_TASK_ID') {
      throw corrupt('Task state directory contains a malformed task filename.');
    }
    throw error;
  }
}

function validateTaskCapsule(input: unknown): TaskCapsule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('Task capsule must be an object.');
  const raw = input as Record<string, unknown>;
  const id = validTaskId(String(raw.id ?? ''));
  const userObjective = boundedText(raw.userObjective, 256 * 1024, 'userObjective');
  const interpretedObjective = boundedText(raw.interpretedObjective, 256 * 1024, 'interpretedObjective');
  const authorizedScope = boundedTextArray(raw.authorizedScope, MAX_SCOPE_ITEMS, 4096, 'authorizedScope');
  const prohibitedScope = boundedTextArray(raw.prohibitedScope, MAX_SCOPE_ITEMS, 4096, 'prohibitedScope');
  const successConditions = boundedTextArray(raw.successConditions, MAX_CONDITIONS, 16_384, 'successConditions');
  const intent = raw.intent === undefined ? undefined : validIntentBinding(raw.intent);
  const state = validTaskState(raw.state, 'task state');
  const nodes = validateNodes(raw.nodes);
  const evidence = validateEvidenceArray(raw.evidence, MAX_EVIDENCE, 'task evidence');
  const failures = validateFailures(raw.failures);
  const execution = raw.execution === undefined ? undefined : validateExecution(raw.execution);
  const createdAt = validIso(raw.createdAt, 'createdAt');
  const updatedAt = validIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw corrupt('Task updatedAt cannot precede createdAt.');
  return {
    id,
    userObjective,
    interpretedObjective,
    authorizedScope,
    prohibitedScope,
    successConditions,
    ...(intent ? { intent } : {}),
    state,
    nodes,
    evidence,
    failures,
    ...(execution ? { execution } : {}),
    createdAt,
    updatedAt
  };
}

function validateExecution(input: unknown): TaskExecution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('execution must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw corrupt('execution schemaVersion is invalid.');
  const plannerId = boundedText(raw.plannerId, 256, 'execution plannerId');
  const goalKind = boundedText(raw.goalKind, 256, 'execution goalKind');
  const plannerState = jsonObject(raw.plannerState, 'execution plannerState');
  if (plannerState.durablePlan !== undefined) {
    try { plannerState.durablePlan = normalizeDurableTaskPlan(plannerState.durablePlan); }
    catch { throw corrupt('execution durable task plan is invalid.'); }
  }
  const maxSteps = boundedInteger(raw.maxSteps, 1, 1000, 'execution maxSteps');
  const maxAttemptsPerStep = boundedInteger(raw.maxAttemptsPerStep, 1, 20, 'execution maxAttemptsPerStep');
  const timeoutMs = boundedInteger(raw.timeoutMs, 100, 24 * 60 * 60 * 1000, 'execution timeoutMs');
  const stepCount = boundedInteger(raw.stepCount, 0, maxSteps, 'execution stepCount');
  const plannerIterations = raw.plannerIterations === undefined
    ? stepCount
    : boundedInteger(raw.plannerIterations, 0, 1_000_000, 'execution plannerIterations');
  const progressExtensions = raw.progressExtensions === undefined
    ? 0
    : boundedInteger(raw.progressExtensions, 0, maxSteps, 'execution progressExtensions');
  const progressProofDigests = raw.progressProofDigests === undefined
    ? []
    : boundedTextArray(raw.progressProofDigests, Math.min(MAX_PROGRESS_PROOFS, maxSteps), 64, 'execution progressProofDigests');
  if (progressProofDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) throw corrupt('execution progressProofDigests must contain SHA-256 digests.');
  if (new Set(progressProofDigests).size !== progressProofDigests.length) throw corrupt('execution progressProofDigests must be unique.');
  if (progressExtensions !== progressProofDigests.length) throw corrupt('execution progressExtensions must equal its durable proof count.');
  const preDispatchReobserves = raw.preDispatchReobserves === undefined
    ? 0
    : boundedInteger(raw.preDispatchReobserves, 0, 1_000_000, 'execution preDispatchReobserves');
  const dispatchedActions = raw.dispatchedActions === undefined
    ? stepCount
    : boundedInteger(raw.dispatchedActions, 0, maxSteps, 'execution dispatchedActions');
  if (dispatchedActions !== stepCount) throw corrupt('execution dispatchedActions must equal the charged environment stepCount.');
  const startedAt = raw.startedAt === undefined ? undefined : validIso(raw.startedAt, 'execution startedAt');
  const deadlineAt = raw.deadlineAt === undefined ? undefined : validIso(raw.deadlineAt, 'execution deadlineAt');
  if ((startedAt === undefined) !== (deadlineAt === undefined)) throw corrupt('execution timing fields must appear together.');
  if (startedAt && deadlineAt && Date.parse(deadlineAt) <= Date.parse(startedAt)) throw corrupt('execution deadline must follow start.');
  if (!Array.isArray(raw.records) || raw.records.length > MAX_ACTION_RECORDS) throw corrupt(`execution records must contain at most ${MAX_ACTION_RECORDS} entries.`);
  const records = raw.records.map((entry, index) => validateActionRecord(entry, index));
  const plannerEvents = raw.plannerEvents === undefined ? [] : validatePlannerEvents(raw.plannerEvents);
  const rejectedDecisions = raw.rejectedDecisions === undefined ? [] : validateRejectedDecisions(raw.rejectedDecisions);
  return {
    schemaVersion: 1, plannerId, goalKind, plannerState, maxSteps, maxAttemptsPerStep, timeoutMs, stepCount,
    plannerIterations, progressExtensions, progressProofDigests, preDispatchReobserves, dispatchedActions,
    ...(startedAt ? { startedAt, deadlineAt } : {}), records,
    ...(plannerEvents.length > 0 ? { plannerEvents } : {}),
    ...(rejectedDecisions.length > 0 ? { rejectedDecisions } : {})
  };
}

function validateRejectedDecisions(input: unknown): TaskRejectedDecision[] {
  if (!Array.isArray(input) || input.length > MAX_REJECTED_DECISIONS) {
    throw corrupt(`execution rejectedDecisions must contain at most ${MAX_REJECTED_DECISIONS} entries.`);
  }
  const decisionTypes = new Set<TaskRejectedDecision['decisionType']>(['invalid', 'complete', 'step']);
  const authorityStates = new Set<TaskRejectedDecision['authorityState']>(['INTENT_BOUND', 'TASK_SCOPE_BOUND']);
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`rejected decision ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    const decisionType = String(raw.decisionType) as TaskRejectedDecision['decisionType'];
    const authorityState = String(raw.authorityState) as TaskRejectedDecision['authorityState'];
    if (!decisionTypes.has(decisionType)) throw corrupt(`rejected decision ${index} type is invalid.`);
    if (!authorityStates.has(authorityState)) throw corrupt(`rejected decision ${index} authorityState is invalid.`);
    const resource = raw.resourceContext;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw corrupt(`rejected decision ${index} resourceContext is invalid.`);
    const resourceRaw = resource as Record<string, unknown>;
    const capability = resourceRaw.capability === undefined ? undefined : boundedText(resourceRaw.capability, 256, `rejected decision ${index} capability`);
    const targetDigest = resourceRaw.targetDigest === undefined ? undefined : digest(resourceRaw.targetDigest, `rejected decision ${index} targetDigest`);
    const actionCorrelation = raw.actionCorrelation === undefined ? undefined : digest(raw.actionCorrelation, `rejected decision ${index} actionCorrelation`);
    for (const field of ['retryAllowed', 'reobserveAllowed', 'replanAllowed'] as const) {
      if (typeof raw[field] !== 'boolean') throw corrupt(`rejected decision ${index} ${field} is invalid.`);
    }
    return {
      taskId: boundedText(raw.taskId, 128, `rejected decision ${index} taskId`),
      ...(actionCorrelation ? { actionCorrelation } : {}),
      decisionDigest: digest(raw.decisionDigest, `rejected decision ${index} decisionDigest`),
      decisionType,
      code: boundedText(raw.code, 256, `rejected decision ${index} code`),
      reason: boundedText(raw.reason, 1024, `rejected decision ${index} reason`),
      authorityState,
      resourceContext: { ...(capability ? { capability } : {}), ...(targetDigest ? { targetDigest } : {}) },
      observationDigest: digest(raw.observationDigest, `rejected decision ${index} observationDigest`),
      at: validIso(raw.at, `rejected decision ${index} at`),
      retryAllowed: raw.retryAllowed as boolean,
      reobserveAllowed: raw.reobserveAllowed as boolean,
      replanAllowed: raw.replanAllowed as boolean
    };
  });
}

function digest(input: unknown, name: string): string {
  const value = boundedText(input, 64, name);
  if (!/^[0-9a-f]{64}$/.test(value)) throw corrupt(`${name} is invalid.`);
  return value;
}

function validatePlannerEvents(input: unknown): TaskPlannerEvent[] {
  if (!Array.isArray(input) || input.length > 100) throw corrupt('execution plannerEvents must contain at most 100 entries.');
  const kinds = new Set<PlannerEventKind>(['STALE_TARGET', 'AMBIGUOUS_TARGET', 'ACTION_SUCCEEDED_BUT_NO_PROGRESS', 'SETTLE_TIMEOUT', 'UI_CHANGED', 'RESOURCE_BUSY', 'STATE_CHANGED', 'RECONCILIATION_REQUIRED', 'PROVIDER_TEMPORARILY_UNAVAILABLE']);
  const decisions = new Set<PlannerEventDecision>(['REOBSERVE', 'REPLAN', 'REPAIR', 'RECONCILE', 'WAIT', 'FAIL']);
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`planner event ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    const kind = String(raw.kind) as PlannerEventKind;
    const decision = String(raw.decision) as PlannerEventDecision;
    if (!kinds.has(kind) || !decisions.has(decision)) throw corrupt(`planner event ${index} kind/decision is invalid.`);
    const event: TaskPlannerEvent = {
      kind, decision,
      code: boundedText(raw.code, 256, `planner event ${index} code`),
      at: validIso(raw.at, `planner event ${index} at`),
      provider: boundedText(raw.provider, 512, `planner event ${index} provider`),
      capability: boundedText(raw.capability, 256, `planner event ${index} capability`)
    };
    if (raw.epistemicStatus !== undefined) {
      const statuses = new Set<EpistemicStatus>(['KNOWN', 'UNKNOWN', 'AMBIGUOUS', 'CONTRADICTED', 'UNAVAILABLE', 'UNAUTHORIZED', 'EXECUTION_UNCERTAIN', 'VERIFIED_FALSE']);
      const status = String(raw.epistemicStatus) as EpistemicStatus;
      if (!statuses.has(status)) throw corrupt(`planner event ${index} epistemicStatus is invalid.`);
      event.epistemicStatus = status;
    }
    if (raw.settled !== undefined) {
      if (typeof raw.settled !== 'boolean') throw corrupt(`planner event ${index} settled is invalid.`);
      event.settled = raw.settled;
    }
    for (const field of ['elapsedMs', 'lastMutationVersion', 'busy', 'dialogs'] as const) {
      if (raw[field] !== undefined) event[field] = boundedInteger(raw[field], 0, Number.MAX_SAFE_INTEGER, `planner event ${index} ${field}`);
    }
    if (raw.reason !== undefined) event.reason = boundedText(raw.reason, 1024, `planner event ${index} reason`);
    if (raw.deltaSummary !== undefined) {
      const delta = raw.deltaSummary;
      if (!delta || typeof delta !== 'object' || Array.isArray(delta) || typeof (delta as any).progress !== 'boolean') throw corrupt(`planner event ${index} deltaSummary is invalid.`);
      event.deltaSummary = {
        progress: (delta as any).progress,
        repeatedNoProgress: boundedInteger((delta as any).repeatedNoProgress, 0, Number.MAX_SAFE_INTEGER, `planner event ${index} repeatedNoProgress`)
      };
    }
    return event;
  });
}

function validateActionRecord(input: unknown, index: number): TaskActionRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt(`Action record ${index} must be an object.`);
  const raw = input as Record<string, unknown>;
  const state = String(raw.state ?? '');
  if (!['STARTED', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(state)) throw corrupt(`Action record ${index} state is invalid.`);
  const inputHash = boundedText(raw.inputHash, 64, `action record ${index} inputHash`);
  if (!/^[0-9a-f]{64}$/.test(inputHash)) throw corrupt(`Action record ${index} inputHash is invalid.`);
  const risk = String(raw.risk ?? '');
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(risk)) throw corrupt(`Action record ${index} risk is invalid.`);
  const sideEffectState = raw.sideEffectState === undefined ? undefined : String(raw.sideEffectState);
  if (sideEffectState !== undefined && !['none', 'known', 'uncertain'].includes(sideEffectState)) throw corrupt(`Action record ${index} sideEffectState is invalid.`);
  const executionPhase = raw.executionPhase === undefined ? undefined : String(raw.executionPhase);
  if (executionPhase !== undefined && !['pre_dispatch', 'dispatched', 'effect_observed', 'reconciled'].includes(executionPhase)) {
    throw corrupt(`Action record ${index} executionPhase is invalid.`);
  }
  const startedAt = validIso(raw.startedAt, `action record ${index} startedAt`);
  const finishedAt = raw.finishedAt === undefined ? undefined : validIso(raw.finishedAt, `action record ${index} finishedAt`);
  if (state === 'STARTED' && finishedAt !== undefined) throw corrupt(`Action record ${index} cannot finish while STARTED.`);
  if (state !== 'STARTED' && finishedAt === undefined) throw corrupt(`Action record ${index} must include finishedAt.`);
  if (finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) throw corrupt(`Action record ${index} finishedAt cannot precede startedAt.`);
  return {
    stepKey: boundedText(raw.stepKey, 256, `action record ${index} stepKey`),
    actionId: boundedText(raw.actionId, 256, `action record ${index} actionId`),
    capability: boundedText(raw.capability, 256, `action record ${index} capability`),
    risk: risk as TaskActionRecord['risk'],
    inputHash,
    attempt: boundedInteger(raw.attempt, 1, 20, `action record ${index} attempt`),
    state: state as TaskActionRecord['state'],
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(raw.errorCode === undefined ? {} : { errorCode: boundedText(raw.errorCode, 256, `action record ${index} errorCode`) }),
    ...(sideEffectState === undefined ? {} : { sideEffectState: sideEffectState as TaskActionRecord['sideEffectState'] }),
    ...(executionPhase === undefined ? {} : { executionPhase: executionPhase as TaskActionRecord['executionPhase'] }),
    ...(raw.observation === undefined ? {} : { observation: validateObservation(raw.observation, index) }),
    evidence: validateEvidenceArray(raw.evidence, MAX_EVIDENCE, `action record ${index} evidence`)
  };
}

function validateObservation(input: unknown, index: number): TaskObservationSummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt(`Action record ${index} observation must be an object.`);
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw corrupt(`Action record ${index} observation schemaVersion is invalid.`);
  const channel = String(raw.channel ?? '');
  if (channel !== 'semantic' && channel !== 'visual') throw corrupt(`Action record ${index} observation channel is invalid.`);
  const domain = String(raw.domain ?? '');
  if (!['project', 'filesystem', 'git', 'docker', 'database', 'ide', 'browser', 'uia', 'process', 'system', 'application', 'visual', 'unknown'].includes(domain)) {
    throw corrupt(`Action record ${index} observation domain is invalid.`);
  }
  const provider = boundedText(raw.provider, 256, `action record ${index} observation provider`);
  const observedAt = validIso(raw.observedAt, `action record ${index} observation observedAt`);
  if (raw.schemaVersion === 1) {
    return { schemaVersion: 1, channel, domain: domain as TaskObservationSummary['domain'], provider, observedAt };
  }
  const importantState = jsonObject(raw.importantState, `action record ${index} observation importantState`);
  if (Buffer.byteLength(JSON.stringify(importantState), 'utf8') > 16 * 1024) throw corrupt(`Action record ${index} observation importantState is too large.`);
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw corrupt(`Action record ${index} observation confidence is invalid.`);
  if (typeof raw.ambiguous !== 'boolean') throw corrupt(`Action record ${index} observation ambiguous must be boolean.`);
  const epistemicStatuses = new Set<EpistemicStatus>(['KNOWN', 'UNKNOWN', 'AMBIGUOUS', 'CONTRADICTED', 'UNAVAILABLE', 'UNAUTHORIZED', 'EXECUTION_UNCERTAIN', 'VERIFIED_FALSE']);
  const epistemicStatus = raw.epistemicStatus === undefined
    ? (raw.ambiguous ? 'AMBIGUOUS' : 'KNOWN')
    : String(raw.epistemicStatus) as EpistemicStatus;
  if (!epistemicStatuses.has(epistemicStatus)) throw corrupt(`Action record ${index} observation epistemicStatus is invalid.`);
  const epistemicReason = raw.epistemicReason === undefined
    ? (epistemicStatus === 'AMBIGUOUS' ? 'LEGACY_AMBIGUOUS_OBSERVATION' : 'LEGACY_KNOWN_OBSERVATION')
    : boundedText(raw.epistemicReason, 128, `action record ${index} observation epistemicReason`);
  if ((epistemicStatus === 'AMBIGUOUS') !== raw.ambiguous) throw corrupt(`Action record ${index} observation ambiguity fields disagree.`);
  const evidenceRefs = boundedHashArray(raw.evidenceRefs, 100, `action record ${index} observation evidenceRefs`);
  const stateVersion = boundedHash(raw.stateVersion, `action record ${index} observation stateVersion`);
  return {
    schemaVersion: 2, channel, domain: domain as TaskObservationSummary['domain'], provider,
    capability: boundedText(raw.capability, 256, `action record ${index} observation capability`),
    entityId: boundedText(raw.entityId, 256, `action record ${index} observation entityId`),
    observedAt, stateVersion, importantState, epistemicStatus, epistemicReason, ambiguous: raw.ambiguous, confidence, evidenceRefs
  };
}

function validateNodes(input: unknown): TaskNode[] {
  if (!Array.isArray(input) || input.length > MAX_NODES) throw corrupt(`nodes must contain at most ${MAX_NODES} entries.`);
  const ids = new Set<string>();
  const keys = new Set<string>();
  const nodes = input.map((entry, index): TaskNode => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`Node ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    const id = validTaskId(String(raw.id ?? ''));
    if (ids.has(id)) throw corrupt(`Node ${index} duplicates node id ${id}.`);
    ids.add(id);
    const key = raw.key === undefined ? undefined : boundedText(raw.key, 256, `node ${index} key`);
    if (key && keys.has(key)) throw corrupt(`Node ${index} duplicates node key ${key}.`);
    if (key) keys.add(key);
    const stepKey = raw.stepKey === undefined ? undefined : boundedText(raw.stepKey, 256, `node ${index} stepKey`);
    const actionId = raw.actionId === undefined ? undefined : boundedText(raw.actionId, 256, `node ${index} actionId`);
    const title = boundedText(raw.title, 16_384, `node ${index} title`);
    const state = validTaskState(raw.state, `node ${index} state`);
    if (typeof raw.required !== 'boolean') throw corrupt(`Node ${index} required must be boolean.`);
    const dependsOn = validateIdArray(raw.dependsOn, MAX_NODES, `node ${index} dependsOn`);
    const evidence = validateEvidenceArray(raw.evidence, MAX_EVIDENCE, `node ${index} evidence`);
    return { id, ...(key ? { key } : {}), ...(stepKey ? { stepKey } : {}), ...(actionId ? { actionId } : {}), title, state, required: raw.required, dependsOn, evidence };
  });

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id || !ids.has(dependency)) throw corrupt(`Node ${node.id} has an invalid dependency ${dependency}.`);
    }
  }
  assertAcyclic(nodes);
  return nodes;
}

function validateEvidenceArray(input: unknown, max: number, label: string): Evidence[] {
  if (!Array.isArray(input) || input.length > max) throw corrupt(`${label} must contain at most ${max} entries.`);
  return input.map((entry, index): Evidence => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`${label} entry ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    const kind = boundedText(raw.kind, 256, `${label} entry ${index} kind`);
    const status = raw.status === 'pass' || raw.status === 'fail' || raw.status === 'info' ? raw.status : null;
    if (!status) throw corrupt(`${label} entry ${index} status is invalid.`);
    const message = boundedText(raw.message, 64 * 1024, `${label} entry ${index} message`);
    const timestamp = validIso(raw.timestamp, `${label} entry ${index} timestamp`);
    let data = raw.data === undefined ? undefined : jsonObject(raw.data, `${label} entry ${index} data`);
    if (kind === 'adaptive_recovery_shadow') {
      try { data = validateRecoveryShadowRecommendation(data) as unknown as Record<string, unknown>; }
      catch { throw corrupt(`${label} entry ${index} recovery shadow lineage is invalid.`); }
    }
    if (kind === 'adaptive_strategy_shadow') {
      try { data = validateStrategyShadowAssessment(data) as unknown as Record<string, unknown>; }
      catch { throw corrupt(`${label} entry ${index} strategy shadow lineage is invalid.`); }
    }
    return { kind, status, message, ...(data ? { data } : {}), timestamp };
  });
}

function validateFailures(input: unknown): TaskCapsule['failures'] {
  if (!Array.isArray(input) || input.length > MAX_FAILURES) throw corrupt(`failures must contain at most ${MAX_FAILURES} entries.`);
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`Failure ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    return {
      at: validIso(raw.at, `failure ${index} at`),
      code: boundedText(raw.code, 256, `failure ${index} code`),
      message: boundedText(raw.message, 64 * 1024, `failure ${index} message`)
    };
  });
}

function assertAcyclic(nodes: TaskNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw corrupt('Task dependency graph contains a cycle.');
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function jsonObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt(`${label} must be a JSON object.`);
  let text: string;
  try { text = JSON.stringify(input); } catch { throw corrupt(`${label} must be JSON serializable.`); }
  if (!text) throw corrupt(`${label} must be JSON serializable.`);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt(`${label} must remain an object after serialization.`);
  return parsed as Record<string, unknown>;
}

function boundedTextArray(input: unknown, maxItems: number, maxText: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw corrupt(`${label} must contain at most ${maxItems} entries.`);
  return input.map((value, index) => boundedText(value, maxText, `${label}[${index}]`));
}

function validateIdArray(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw corrupt(`${label} must contain at most ${maxItems} ids.`);
  const ids = input.map((value) => validTaskId(String(value ?? '')));
  if (new Set(ids).size !== ids.length) throw corrupt(`${label} contains duplicate ids.`);
  return ids;
}

function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw corrupt(`${label} is invalid.`);
  return input;
}

function boundedHash(input: unknown, label: string): string {
  const value = boundedText(input, 64, label);
  if (!/^[0-9a-f]{64}$/.test(value)) throw corrupt(`${label} must be a SHA-256 hex digest.`);
  return value;
}

function boundedHashArray(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw corrupt(`${label} must contain at most ${maxItems} hashes.`);
  return input.map((value, index) => boundedHash(value, `${label}[${index}]`));
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw corrupt(`${label} is invalid.`);
  return value;
}

function validIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt(`${label} must be an ISO timestamp.`);
  return value;
}

function validTaskState(input: unknown, label: string): TaskState {
  const value = String(input ?? '') as TaskState;
  if (!TASK_STATES.has(value)) throw corrupt(`${label} is invalid.`);
  return value;
}

function validTaskId(input: string): string {
  const value = String(input ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OperatorError('INVALID_TASK_ID', 'Invalid task id.');
  }
  return value.toLowerCase();
}

function corrupt(message: string): OperatorError {
  return new OperatorError('TASK_STATE_CORRUPT', message);
}
