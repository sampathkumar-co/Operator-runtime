import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import type { IntentBinding } from './types.ts';

export interface ExecutionContextIdentityV1 {
  schemaVersion: 1;
  accountId?: string;
  deviceId?: string;
  sessionId?: string;
  conversationId?: string;
  intentVersion?: number;
  intentDigest?: string;
  taskId?: string;
  goalId?: string;
  planId?: string;
  planRevision?: number;
  nodeId?: string;
  actionId?: string;
  attempt?: number;
  authorityVersion?: number;
  resourceRevision?: string;
  leaseId?: string;
  fenceToken?: string;
  evaluationRunId?: string;
}

export type ExecutionContextIdentity = ExecutionContextIdentityV1;

const ID_PATTERN = /^[A-Za-z0-9._:@/+\-=]{1,256}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function invalid(message: string, details?: Record<string, unknown>): OperatorError {
  return new OperatorError('EXECUTION_IDENTITY_INVALID', message, { details });
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${label} must be a literal positive integer.`);
  }
  return value;
}

export function normalizeExecutionContextIdentity(input: unknown): ExecutionContextIdentity {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
       Object.getPrototypeOf(input) !== null)) {
    throw invalid('Execution context identity must be an inert plain object.');
  }
  // Snapshot all source values exactly once before parsing principal, device,
  // intent or authority fields. Direct raw.foo access runs getters, which may
  // return different identities on successive reads or execute attacker code.
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const raw: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') {
      throw invalid('Execution context identity may not contain symbol fields.');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid('Execution context identity may contain only enumerable own data fields.');
    }
    raw[key] = descriptor.value;
  }
  if (raw.schemaVersion !== 1) throw invalid('Execution context identity schemaVersion must be 1.');

  const conversationId = optionalId(raw.conversationId, 'conversationId');
  const intentVersion = optionalPositiveInteger(raw.intentVersion, 'intentVersion');
  let intentDigest: string | undefined;
  if (raw.intentDigest !== undefined) {
    if (typeof raw.intentDigest !== 'string' || !HEX_64.test(raw.intentDigest.toLowerCase())) {
      throw invalid('intentDigest must be a literal hexadecimal hash.');
    }
    intentDigest = raw.intentDigest.toLowerCase();
  }
  const intentParts = [conversationId, intentVersion, intentDigest].filter((value) => value !== undefined).length;
  if (intentParts !== 0 && intentParts !== 3) {
    throw invalid('conversationId, intentVersion and intentDigest must be supplied together.');
  }

  const planId = optionalId(raw.planId, 'planId');
  const planRevision = optionalPositiveInteger(raw.planRevision, 'planRevision');
  if ((planId === undefined) !== (planRevision === undefined)) {
    throw invalid('planId and planRevision must be supplied together.');
  }

  const attempt = optionalPositiveInteger(raw.attempt, 'attempt');
  if (attempt !== undefined && raw.actionId === undefined) {
    throw invalid('attempt requires actionId.');
  }

  const normalized: ExecutionContextIdentity = {
    schemaVersion: 1,
    ...(optionalId(raw.accountId, 'accountId') ? { accountId: optionalId(raw.accountId, 'accountId') } : {}),
    ...(optionalId(raw.deviceId, 'deviceId') ? { deviceId: optionalId(raw.deviceId, 'deviceId') } : {}),
    ...(optionalId(raw.sessionId, 'sessionId') ? { sessionId: optionalId(raw.sessionId, 'sessionId') } : {}),
    ...(conversationId ? { conversationId, intentVersion: intentVersion!, intentDigest: intentDigest! } : {}),
    ...(optionalId(raw.taskId, 'taskId') ? { taskId: optionalId(raw.taskId, 'taskId') } : {}),
    ...(optionalId(raw.goalId, 'goalId') ? { goalId: optionalId(raw.goalId, 'goalId') } : {}),
    ...(planId ? { planId, planRevision: planRevision! } : {}),
    ...(optionalId(raw.nodeId, 'nodeId') ? { nodeId: optionalId(raw.nodeId, 'nodeId') } : {}),
    ...(optionalId(raw.actionId, 'actionId') ? { actionId: optionalId(raw.actionId, 'actionId') } : {}),
    ...(attempt ? { attempt } : {}),
    ...(optionalPositiveInteger(raw.authorityVersion, 'authorityVersion') ? { authorityVersion: optionalPositiveInteger(raw.authorityVersion, 'authorityVersion') } : {}),
    ...(optionalId(raw.resourceRevision, 'resourceRevision') ? { resourceRevision: optionalId(raw.resourceRevision, 'resourceRevision') } : {}),
    ...(optionalId(raw.leaseId, 'leaseId') ? { leaseId: optionalId(raw.leaseId, 'leaseId') } : {}),
    ...(optionalId(raw.fenceToken, 'fenceToken') ? { fenceToken: optionalId(raw.fenceToken, 'fenceToken') } : {}),
    ...(optionalId(raw.evaluationRunId, 'evaluationRunId') ? { evaluationRunId: optionalId(raw.evaluationRunId, 'evaluationRunId') } : {})
  };

  if (Object.keys(normalized).length === 1) throw invalid('Execution context identity must bind at least one runtime identity.');
  return normalized;
}

export function executionContextIdentityFrom(input: {
  accountId?: string;
  deviceId?: string;
  sessionId?: string;
  intent?: IntentBinding;
  taskId?: string;
  goalId?: string;
  planId?: string;
  planRevision?: number;
  nodeId?: string;
  actionId?: string;
  attempt?: number;
  authorityVersion?: number;
  resourceRevision?: string;
  leaseId?: string;
  fenceToken?: string;
  evaluationRunId?: string;
}): ExecutionContextIdentity {
  return normalizeExecutionContextIdentity({
    schemaVersion: 1,
    ...input,
    ...(input.intent ? {
      conversationId: input.intent.conversationId,
      intentVersion: input.intent.intentVersion,
      intentDigest: input.intent.digest
    } : {})
  });
}

export function executionContextDigest(input: ExecutionContextIdentity): string {
  const normalized = normalizeExecutionContextIdentity(input);
  return crypto.createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

export function sameExecutionContext(left: ExecutionContextIdentity, right: ExecutionContextIdentity): boolean {
  return executionContextDigest(left) === executionContextDigest(right);
}
