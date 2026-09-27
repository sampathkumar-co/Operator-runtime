import { createHash, randomUUID } from 'node:crypto';
import type { ActionRisk, Evidence, TaskState } from './types.ts';
import { OperatorError } from './errors.ts';

export interface TaskNode {
  id: string;
  /** Stable execution-node identity. Optional only for backwards compatibility with v1 capsules. */
  key?: string;
  /** Logical planner step identity; multiple attempts may share the same stepKey. */
  stepKey?: string;
  /** Deterministic action identity correlated to this execution node. */
  actionId?: string;
  title: string;
  state: TaskState;
  required: boolean;
  dependsOn: string[];
  evidence: Evidence[];
}

export interface TaskActionRecord {
  stepKey: string;
  actionId: string;
  capability: string;
  risk: ActionRisk;
  inputHash: string;
  attempt: number;
  state: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'INTERRUPTED';
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  observation?: TaskObservationSummary;
  evidence: Evidence[];
}

export type TaskObservationDomain =
  | 'project' | 'filesystem' | 'git' | 'docker' | 'database' | 'ide'
  | 'browser' | 'uia' | 'process' | 'system' | 'application' | 'visual' | 'unknown';

export interface TaskObservationSummaryV1 {
  schemaVersion: 1;
  channel: 'semantic' | 'visual';
  domain: TaskObservationDomain;
  provider: string;
  observedAt: string;
}

export interface TaskObservationSummaryV2 {
  schemaVersion: 2;
  channel: 'semantic' | 'visual';
  domain: TaskObservationDomain;
  provider: string;
  capability: string;
  entityId: string;
  observedAt: string;
  stateVersion: string;
  importantState: Record<string, unknown>;
  ambiguous: boolean;
  confidence: number;
  evidenceRefs: string[];
}

export type TaskObservationSummary = TaskObservationSummaryV1 | TaskObservationSummaryV2;

export interface TaskExecution {
  schemaVersion: 1;
  plannerId: string;
  goalKind: string;
  plannerState: Record<string, unknown>;
  maxSteps: number;
  maxAttemptsPerStep: number;
  timeoutMs: number;
  stepCount: number;
  startedAt?: string;
  deadlineAt?: string;
  records: TaskActionRecord[];
}

export interface TaskCapsule {
  id: string;
  userObjective: string;
  interpretedObjective: string;
  authorizedScope: string[];
  prohibitedScope: string[];
  successConditions: string[];
  state: TaskState;
  nodes: TaskNode[];
  evidence: Evidence[];
  failures: Array<{ at: string; code: string; message: string }>;
  execution?: TaskExecution;
  createdAt: string;
  updatedAt: string;
}

export function createTask(input: Omit<TaskCapsule, 'id' | 'state' | 'nodes' | 'evidence' | 'failures' | 'createdAt' | 'updatedAt'>): TaskCapsule {
  const now = new Date().toISOString();
  return {
    ...input,
    id: randomUUID(),
    state: 'PENDING',
    nodes: [],
    evidence: [],
    failures: [],
    createdAt: now,
    updatedAt: now
  };
}

export function addTaskNode(task: TaskCapsule, title: string, options: { key?: string; stepKey?: string; actionId?: string; required?: boolean; dependsOn?: string[] } = {}): TaskNode {
  const key = options.key?.trim();
  if (key) {
    const existing = task.nodes.find((candidate) => candidate.key === key);
    if (existing) return existing;
  }
  const stepKey = options.stepKey?.trim();
  const actionId = options.actionId?.trim();
  const node: TaskNode = {
    id: key ? stableTaskNodeId(task.id, key) : randomUUID(),
    ...(key ? { key } : {}),
    ...(stepKey ? { stepKey } : {}),
    ...(actionId ? { actionId } : {}),
    title,
    state: 'PENDING',
    required: options.required ?? true,
    dependsOn: options.dependsOn ?? [],
    evidence: []
  };
  task.nodes.push(node);
  task.updatedAt = new Date().toISOString();
  return node;
}

export function setNodeState(task: TaskCapsule, nodeId: string, state: TaskState): void {
  const node = task.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new OperatorError('TASK_NODE_NOT_FOUND', `Task node ${nodeId} was not found.`);

  if (state === 'RUNNING') {
    const blockedDependency = node.dependsOn
      .map((id) => task.nodes.find((candidate) => candidate.id === id))
      .find((dep) => !dep || dep.state !== 'VERIFIED');
    if (blockedDependency) {
      throw new OperatorError('TASK_DEPENDENCY_BLOCKED', `Node ${node.title} has an unverified dependency.`);
    }
  }

  node.state = state;
  task.updatedAt = new Date().toISOString();
}

export function finalizeTask(task: TaskCapsule): void {
  const incomplete = task.nodes.filter((node) => node.required && node.state !== 'VERIFIED' && node.state !== 'SKIPPED');
  if (incomplete.length > 0) {
    throw new OperatorError('TASK_NOT_VERIFIED', 'Required task nodes are incomplete.', {
      details: { nodes: incomplete.map((node) => ({ id: node.id, title: node.title, state: node.state })) }
    });
  }
  task.state = 'VERIFIED';
  task.updatedAt = new Date().toISOString();
}

/** Deterministic UUID-shaped node identity derived only from durable task + planner step identity. */
export function stableTaskNodeId(taskId: string, stepKey: string): string {
  const digest = createHash('sha256').update(taskId).update('\0').update(stepKey).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 4122 variant + v5-shaped version bits. We use SHA-256 rather than SHA-1,
  // because this identifier is internal and only requires deterministic UUID syntax.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stableTaskExecutionNodeKey(stepKey: string, attempt: number, inputHash: string): string {
  return `node-${createHash('sha256').update(stepKey).update('\0').update(String(attempt)).update('\0').update(inputHash).digest('hex')}`;
}
