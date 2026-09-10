import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskCapsule, TaskNode } from './task.ts';
import type { Evidence, TaskState } from './types.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

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
const TASK_STATES = new Set<TaskState>(['PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'VERIFIED', 'SKIPPED']);

export class TaskStore {
  #dir: string;

  constructor(stateDir: string) {
    this.#dir = path.join(path.resolve(stateDir), 'tasks');
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
      .sort()
      .slice(0, limit);
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
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, userObjective, state, updatedAt }) => ({ id, userObjective, state, updatedAt }));
  }

  async delete(taskIdInput: string): Promise<void> {
    await this.init();
    const taskId = validTaskId(taskIdInput);
    await fs.rm(this.#file(taskId), { force: true });
  }

  #file(taskId: string): string {
    return path.join(this.#dir, `${validTaskId(taskId)}.json`);
  }
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
  const state = validTaskState(raw.state, 'task state');
  const nodes = validateNodes(raw.nodes);
  const evidence = validateEvidenceArray(raw.evidence, MAX_EVIDENCE, 'task evidence');
  const failures = validateFailures(raw.failures);
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
    state,
    nodes,
    evidence,
    failures,
    createdAt,
    updatedAt
  };
}

function validateNodes(input: unknown): TaskNode[] {
  if (!Array.isArray(input) || input.length > MAX_NODES) throw corrupt(`nodes must contain at most ${MAX_NODES} entries.`);
  const ids = new Set<string>();
  const nodes = input.map((entry, index): TaskNode => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw corrupt(`Node ${index} must be an object.`);
    const raw = entry as Record<string, unknown>;
    const id = validTaskId(String(raw.id ?? ''));
    if (ids.has(id)) throw corrupt(`Node ${index} duplicates node id ${id}.`);
    ids.add(id);
    const title = boundedText(raw.title, 16_384, `node ${index} title`);
    const state = validTaskState(raw.state, `node ${index} state`);
    if (typeof raw.required !== 'boolean') throw corrupt(`Node ${index} required must be boolean.`);
    const dependsOn = validateIdArray(raw.dependsOn, MAX_NODES, `node ${index} dependsOn`);
    const evidence = validateEvidenceArray(raw.evidence, MAX_EVIDENCE, `node ${index} evidence`);
    return { id, title, state, required: raw.required, dependsOn, evidence };
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
    const data = raw.data === undefined ? undefined : jsonObject(raw.data, `${label} entry ${index} data`);
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
