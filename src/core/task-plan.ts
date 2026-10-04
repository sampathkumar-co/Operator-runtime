import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import type { TaskStateAssertion } from './task-state-assertion.ts';

export type TaskSubgoalStatus = 'PENDING' | 'READY' | 'ACTIVE' | 'BLOCKED' | 'VERIFIED' | 'FAILED' | 'CANCELLED';

export interface TaskPlanAction { capability: string; input: Record<string, unknown>; target?: string }
export interface TaskPlanStepDefinition {
  key: string; title: string; parentKey?: string; dependsOn?: string[]; resourceScope?: string[];
  observe: TaskPlanAction; action: TaskPlanAction; verify: TaskPlanAction & { assertions: TaskStateAssertion[] };
}
export interface TaskPlanSubgoal {
  id: string; key: string; sourceIndex: number; parentId?: string; description: string; dependsOn: string[];
  status: TaskSubgoalStatus; requiredEvidence: string[];
  successContract: TaskPlanAction & { assertions: TaskStateAssertion[] };
  execution: { observe: TaskPlanAction; action: TaskPlanAction };
  attempts: number; resourceScope: string[]; failureReason?: string; updatedAt: string;
}
export interface DurableTaskPlan {
  schemaVersion: 1; taskId: string; revision: number; objective: string; constraints: string[];
  finalSuccessConditions: string[]; subgoals: TaskPlanSubgoal[];
  revisions: Array<{ revision: number; at: string; reason: string; operations: string[] }>;
  updatedAt: string;
}
export type TaskPlanRevisionOperation =
  | { kind: 'replace'; key: string; step: TaskPlanStepDefinition }
  | { kind: 'insert_prerequisite'; beforeKey: string; step: TaskPlanStepDefinition }
  | { kind: 'cancel'; key: string }
  | { kind: 'invalidate'; key: string; reason: string };

const MAX_SUBGOALS = 100;
const MAX_REVISIONS = 100;

export function createDurableTaskPlan(input: {
  taskId: string; objective: string; constraints: string[]; finalSuccessConditions: string[];
  steps: TaskPlanStepDefinition[]; now?: string;
}): DurableTaskPlan {
  const at = validIso(input.now ?? new Date().toISOString(), 'plan timestamp');
  if (input.steps.length < 1 || input.steps.length > MAX_SUBGOALS) throw invalid('A task plan requires 1-100 subgoals.');
  const definitions = structuredClone(input.steps);
  const keys = definitions.map((step) => validKey(step.key));
  if (new Set(keys).size !== keys.length) throw invalid('Task plan subgoal keys must be unique.');
  const ids = new Map(keys.map((key) => [key, stableSubgoalId(input.taskId, key)]));
  const subgoals = definitions.map((step, sourceIndex): TaskPlanSubgoal => {
    const dependsOnKeys = step.dependsOn === undefined ? (sourceIndex === 0 ? [] : [keys[sourceIndex - 1]!]) : uniqueKeys(step.dependsOn);
    if (dependsOnKeys.includes(step.key)) throw invalid(`Subgoal ${step.key} cannot depend on itself.`);
    const dependsOn = dependsOnKeys.map((key) => ids.get(key) ?? missing(key));
    const parentId = step.parentKey === undefined ? undefined : ids.get(validKey(step.parentKey)) ?? missing(step.parentKey);
    return {
      id: ids.get(step.key)!, key: step.key, sourceIndex, ...(parentId ? { parentId } : {}),
      description: bounded(step.title, 512, 'subgoal title'), dependsOn,
      status: dependsOn.length === 0 ? 'READY' : 'PENDING',
      requiredEvidence: ['fresh-machine-observation', 'canonical-verification'],
      successContract: cloneContract(step.verify), execution: { observe: cloneAction(step.observe), action: cloneAction(step.action) },
      attempts: 0, resourceScope: uniqueBounded(step.resourceScope ?? [], 100, 4096, 'resource scope'), updatedAt: at
    };
  });
  assertAcyclic(subgoals);
  return {
    schemaVersion: 1, taskId: bounded(input.taskId, 128, 'task id'), revision: 1,
    objective: bounded(input.objective, 16_384, 'plan objective'),
    constraints: uniqueBounded(input.constraints, 2_000, 16_384, 'plan constraints'),
    finalSuccessConditions: uniqueBounded(input.finalSuccessConditions, 1_000, 16_384, 'final success conditions'),
    subgoals, revisions: [], updatedAt: at
  };
}

export function normalizeDurableTaskPlan(input: unknown): DurableTaskPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Durable task plan must be an object.');
  const raw = structuredClone(input) as DurableTaskPlan;
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw invalid('Durable task plan version is invalid.');
  bounded(raw.taskId, 128, 'task id'); bounded(raw.objective, 16_384, 'plan objective'); validIso(raw.updatedAt, 'plan updatedAt');
  uniqueBounded(raw.constraints, 2_000, 16_384, 'plan constraints');
  uniqueBounded(raw.finalSuccessConditions, 1_000, 16_384, 'final success conditions');
  if (!Array.isArray(raw.subgoals) || raw.subgoals.length < 1 || raw.subgoals.length > MAX_SUBGOALS) throw invalid('Durable task plan subgoals are invalid.');
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const item of raw.subgoals) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('Durable task plan contains an invalid subgoal.');
    validKey(item.key); bounded(item.id, 128, 'subgoal id'); bounded(item.description, 512, 'subgoal description'); validIso(item.updatedAt, 'subgoal updatedAt');
    if (item.id !== stableSubgoalId(raw.taskId, item.key) || ids.has(item.id) || keys.has(item.key)) throw invalid('Durable task plan subgoal identity is invalid.');
    ids.add(item.id); keys.add(item.key);
    if (!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < 0 || item.sourceIndex >= MAX_SUBGOALS) throw invalid('Subgoal source index is invalid.');
    if (!['PENDING', 'READY', 'ACTIVE', 'BLOCKED', 'VERIFIED', 'FAILED', 'CANCELLED'].includes(item.status)) throw invalid('Subgoal status is invalid.');
    if (!Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 1_000_000) throw invalid('Subgoal attempts are invalid.');
    item.dependsOn = uniqueBounded(item.dependsOn, MAX_SUBGOALS, 128, 'subgoal dependencies');
    item.requiredEvidence = uniqueBounded(item.requiredEvidence, 20, 256, 'required evidence');
    item.resourceScope = uniqueBounded(item.resourceScope, 100, 4096, 'resource scope');
    item.successContract = cloneContract(item.successContract);
    item.execution = { observe: cloneAction(item.execution?.observe), action: cloneAction(item.execution?.action) };
    if (item.parentId !== undefined) bounded(item.parentId, 128, 'parent id');
    if (item.failureReason !== undefined) bounded(item.failureReason, 4096, 'failure reason');
  }
  for (const item of raw.subgoals) {
    if (item.dependsOn.some((id) => !ids.has(id) || id === item.id)) throw invalid('Subgoal dependency is invalid.');
    if (item.parentId !== undefined && (!ids.has(item.parentId) || item.parentId === item.id)) throw invalid('Subgoal parent is invalid.');
  }
  assertAcyclic(raw.subgoals);
  if (!Array.isArray(raw.revisions) || raw.revisions.length > MAX_REVISIONS) throw invalid('Task plan revision history is invalid.');
  for (const revision of raw.revisions) {
    if (!revision || !Number.isSafeInteger(revision.revision) || revision.revision < 2 || revision.revision > raw.revision) throw invalid('Task plan revision entry is invalid.');
    validIso(revision.at, 'revision timestamp'); bounded(revision.reason, 4096, 'revision reason'); uniqueBounded(revision.operations, 20, 512, 'revision operations');
  }
  refreshReady(raw, raw.updatedAt);
  return raw;
}

export function nextReadySubgoal(plan: DurableTaskPlan): TaskPlanSubgoal | undefined { refreshReady(plan, plan.updatedAt); return plan.subgoals.find((item) => item.status === 'READY'); }
export function activateSubgoal(plan: DurableTaskPlan, id: string, at = new Date().toISOString()): TaskPlanSubgoal {
  const item = requireSubgoal(plan, id);
  if (item.status !== 'READY' && item.status !== 'ACTIVE') throw invalid(`Subgoal ${item.key} is not ready.`);
  if (item.status === 'READY') item.attempts += 1;
  item.status = 'ACTIVE'; item.updatedAt = validIso(at, 'activation timestamp'); plan.updatedAt = item.updatedAt;
  return item;
}
export function verifySubgoal(plan: DurableTaskPlan, id: string, at = new Date().toISOString()): void {
  const item = requireSubgoal(plan, id);
  if (item.status !== 'ACTIVE') throw invalid(`Subgoal ${item.key} is not active.`);
  item.status = 'VERIFIED'; item.updatedAt = validIso(at, 'verification timestamp'); plan.updatedAt = item.updatedAt; refreshReady(plan, item.updatedAt);
}
export function taskPlanComplete(plan: DurableTaskPlan): boolean { return plan.subgoals.every((item) => item.status === 'VERIFIED' || item.status === 'CANCELLED'); }

export function reviseDurableTaskPlan(planInput: DurableTaskPlan, operations: TaskPlanRevisionOperation[], reason: string, at = new Date().toISOString()): DurableTaskPlan {
  const plan = normalizeDurableTaskPlan(planInput);
  if (operations.length < 1 || operations.length > 20) throw invalid('Plan revision requires 1-20 operations.');
  const timestamp = validIso(at, 'revision timestamp');
  for (const operation of operations) {
    const targetKey = operation.kind === 'insert_prerequisite' ? operation.beforeKey : operation.key;
    const target = plan.subgoals.find((item) => item.key === validKey(targetKey));
    if (!target) throw invalid(`Plan revision target ${targetKey} was not found.`);
    if (operation.kind === 'cancel') {
      if (target.status === 'ACTIVE' || target.status === 'VERIFIED') throw invalid('Active or verified subgoals cannot be cancelled.');
      target.status = 'CANCELLED'; target.updatedAt = timestamp;
    } else if (operation.kind === 'invalidate') {
      if (target.status !== 'VERIFIED') throw invalid('Only a verified subgoal can be invalidated.');
      invalidateDependents(plan, target.id, bounded(operation.reason, 4096, 'invalidation reason'), timestamp);
    } else if (operation.kind === 'replace') {
      if (target.status === 'ACTIVE' || target.status === 'VERIFIED') throw invalid('Active or verified subgoals cannot be replaced.');
      const replacement = createRevisionSubgoal(plan, operation.step, target.sourceIndex, timestamp);
      replacement.id = target.id; replacement.key = target.key; replacement.dependsOn = [...target.dependsOn]; replacement.parentId = target.parentId;
      plan.subgoals[plan.subgoals.indexOf(target)] = replacement;
    } else {
      if (target.status === 'ACTIVE' || target.status === 'VERIFIED') throw invalid('Prerequisites cannot be inserted before active or verified subgoals.');
      if (plan.subgoals.length >= MAX_SUBGOALS) throw invalid('Task plan subgoal limit reached.');
      const inserted = createRevisionSubgoal(plan, operation.step, Math.max(...plan.subgoals.map((item) => item.sourceIndex)) + 1, timestamp);
      if (plan.subgoals.some((item) => item.key === inserted.key)) throw invalid('Inserted prerequisite key already exists.');
      inserted.dependsOn = [...target.dependsOn]; target.dependsOn = [inserted.id]; target.status = 'PENDING'; target.updatedAt = timestamp;
      plan.subgoals.splice(plan.subgoals.indexOf(target), 0, inserted);
    }
  }
  assertAcyclic(plan.subgoals); plan.revision += 1; plan.updatedAt = timestamp;
  plan.revisions.push({ revision: plan.revision, at: timestamp, reason: bounded(reason, 4096, 'revision reason'), operations: operations.map(describeOperation) });
  if (plan.revisions.length > MAX_REVISIONS) plan.revisions.splice(0, plan.revisions.length - MAX_REVISIONS);
  refreshReady(plan, timestamp); return normalizeDurableTaskPlan(plan);
}

function createRevisionSubgoal(plan: DurableTaskPlan, step: TaskPlanStepDefinition, sourceIndex: number, at: string): TaskPlanSubgoal {
  return { id: stableSubgoalId(plan.taskId, validKey(step.key)), key: step.key, sourceIndex, description: bounded(step.title, 512, 'subgoal title'), dependsOn: [], status: 'PENDING', requiredEvidence: ['fresh-machine-observation', 'canonical-verification'], successContract: cloneContract(step.verify), execution: { observe: cloneAction(step.observe), action: cloneAction(step.action) }, attempts: 0, resourceScope: uniqueBounded(step.resourceScope ?? [], 100, 4096, 'resource scope'), updatedAt: at };
}
function refreshReady(plan: DurableTaskPlan, at: string): void {
  const byId = new Map(plan.subgoals.map((item) => [item.id, item]));
  for (const item of plan.subgoals) {
    if (item.status !== 'PENDING' && item.status !== 'READY') continue;
    const ready = item.dependsOn.every((id) => ['VERIFIED', 'CANCELLED'].includes(byId.get(id)?.status ?? ''));
    item.status = ready ? 'READY' : 'PENDING'; if (ready) item.updatedAt = at;
  }
}
function invalidateDependents(plan: DurableTaskPlan, id: string, reason: string, at: string): void {
  const queue = [id]; const seen = new Set<string>();
  while (queue.length) { const current = queue.shift()!; if (seen.has(current)) continue; seen.add(current); const item = requireSubgoal(plan, current); item.status = 'PENDING'; item.failureReason = reason; item.updatedAt = at; for (const dependent of plan.subgoals.filter((candidate) => candidate.dependsOn.includes(current))) queue.push(dependent.id); }
}
function requireSubgoal(plan: DurableTaskPlan, id: string): TaskPlanSubgoal { const item = plan.subgoals.find((candidate) => candidate.id === id); if (!item) throw invalid(`Subgoal ${id} was not found.`); return item; }
function assertAcyclic(items: TaskPlanSubgoal[]): void {
  const dependencies = new Map(items.map((item) => [item.id, item.dependsOn])); const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) throw invalid('Task plan dependency graph contains a cycle.'); if (visited.has(id)) return; visiting.add(id); for (const dependency of dependencies.get(id) ?? []) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const item of items) visit(item.id);
}
function cloneAction(input: TaskPlanAction | undefined): TaskPlanAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Task plan action is invalid.');
  const action: TaskPlanAction = { capability: bounded(input.capability, 256, 'action capability'), input: structuredClone(input.input) };
  if (!action.input || typeof action.input !== 'object' || Array.isArray(action.input) || Buffer.byteLength(canonicalJson(action.input)) > 256 * 1024) throw invalid('Task plan action input is invalid.');
  if (input.target !== undefined) action.target = bounded(input.target, 4096, 'action target'); return action;
}
function cloneContract(input: TaskPlanSubgoal['successContract']): TaskPlanSubgoal['successContract'] { const action = cloneAction(input); if (!Array.isArray(input?.assertions) || input.assertions.length < 1 || input.assertions.length > 20) throw invalid('Task plan success contract assertions are invalid.'); return { ...action, assertions: structuredClone(input.assertions) }; }
function stableSubgoalId(taskId: string, key: string): string { return `subgoal-${crypto.createHash('sha256').update(taskId).update('\0').update(key).digest('hex').slice(0, 32)}`; }
function validKey(value: string): string { const key = bounded(value, 128, 'subgoal key'); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw invalid('Subgoal key is invalid.'); return key; }
function uniqueKeys(values: string[]): string[] { if (!Array.isArray(values) || values.length > MAX_SUBGOALS) throw invalid('Subgoal dependencies are invalid.'); return [...new Set(values.map(validKey))]; }
function uniqueBounded(values: unknown, max: number, length: number, label: string): string[] { if (!Array.isArray(values) || values.length > max) throw invalid(`${label} is invalid.`); const result = values.map((value) => bounded(value, length, label)); if (new Set(result).size !== result.length) throw invalid(`${label} contains duplicates.`); return result; }
function bounded(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) throw invalid(`${label} is invalid.`); return value; }
function validIso(value: unknown, label: string): string { const text = bounded(value, 64, label); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || !Number.isFinite(Date.parse(text))) throw invalid(`${label} is invalid.`); return text; }
function missing(key: string): never { throw invalid(`Task plan refers to unknown subgoal ${key}.`); }
function describeOperation(operation: TaskPlanRevisionOperation): string { return operation.kind === 'insert_prerequisite' ? `${operation.kind}:${operation.beforeKey}:${operation.step.key}` : `${operation.kind}:${operation.key}`; }
function invalid(message: string): OperatorError { return new OperatorError('TASK_PLAN_INVALID', message); }
