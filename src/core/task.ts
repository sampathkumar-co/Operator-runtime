import { randomUUID } from 'node:crypto';
import type { Evidence, TaskState } from './types.ts';
import { OperatorError } from './errors.ts';

export interface TaskNode {
  id: string;
  title: string;
  state: TaskState;
  required: boolean;
  dependsOn: string[];
  evidence: Evidence[];
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

export function addTaskNode(task: TaskCapsule, title: string, options: { required?: boolean; dependsOn?: string[] } = {}): TaskNode {
  const node: TaskNode = {
    id: randomUUID(),
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
