import type { AccountPrincipal } from '../../../src/core/account-device-registry.ts';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';
import { RelayAgentClient } from './relay-agent-client.ts';

export type TaskControlOperation = 'inspect' | 'run' | 'pause' | 'resume' | 'cancel';
export type TaskSubmitInput = {
  requestId: string;
  objective: string;
  successConditions: string[];
  prohibitedScope?: string[];
  goal: Record<string, unknown>;
  run?: boolean;
  maxSteps?: number;
  maxAttemptsPerStep?: number;
  timeoutMs?: number;
};
export type TaskTransportResult = {
  ok: boolean;
  task?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

export type OperationControlOperation = 'inspect' | 'start' | 'refresh' | 'pause' | 'cancel' | 'promote';
export type OperationSubmitInput = Record<string, unknown> & {
  requestId: string;
  resourceRequirements?: {
    requiredTags?: string[];
    minMemoryMb?: number;
    requireGpu?: boolean;
    slots?: number;
  };
};
export type OperationTransportResult = {
  ok: boolean;
  operation?: Record<string, unknown>;
  error?: { code?: string; message?: string };
};

export type KnowledgeInspectInput =
  | { kind: 'procedures'; limit?: number }
  | {
      kind: 'procedure-query';
      objectiveKind: string;
      scopeKey: string;
      assumptions?: Array<{ key: string; fingerprint: string }>;
      requiredCapabilities?: string[];
      maxResults?: number;
    }
  | { kind: 'world-entity'; entityKey: string }
  | { kind: 'world-fact'; entityKey: string; factKey: string }
  | { kind: 'world-history'; entityKey: string; factKey?: string; source?: string; since?: string; until?: string; limit?: number }
  | { kind: 'world-trace'; fromKey: string; toKey?: string; targetType?: string; maxDepth?: number; minConfidence?: number }
  | { kind: 'world-list'; scopeKey?: string; type?: string; limit?: number }
  | { kind: 'optimizer'; limit?: number };

export type KnowledgeTransportResult = {
  ok: boolean;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
};

type Executor = {
  execute(action: ActionRequest): Promise<ActionResult>;
  submitTask(input: TaskSubmitInput): Promise<TaskTransportResult>;
  controlTask(taskId: string, operation: TaskControlOperation): Promise<TaskTransportResult>;
  submitOperation(input: OperationSubmitInput): Promise<OperationTransportResult>;
  controlOperation(operationId: string, operation: OperationControlOperation, verificationDigest?: string): Promise<OperationTransportResult>;
  inspectKnowledge(input: KnowledgeInspectInput): Promise<KnowledgeTransportResult>;
  claimDevice?(userCode: string, makeDefault?: boolean): Promise<{ status: 'claimed' }>;
};

export class LocalAgentClient {
  #executor: Executor;

  constructor(baseUrl: string, token: string, verifiedPrincipal?: AccountPrincipal) {
    const mode = (process.env.OPERATOR_EXECUTION_MODE ?? 'local').trim().toLowerCase();
    if (mode === 'local') {
      this.#executor = new DirectLocalAgentClient(baseUrl, token);
      return;
    }
    if (mode !== 'relay') throw new Error('OPERATOR_EXECUTION_MODE must be local or relay.');

    const relayToken = process.env.OPERATOR_RELAY_CONTROL_TOKEN?.trim() || token;
    const accountId = verifiedPrincipal ? undefined : process.env.OPERATOR_RELAY_ACCOUNT_ID?.trim();
    if (!verifiedPrincipal && !accountId) throw new Error('Relay execution requires OPERATOR_RELAY_ACCOUNT_ID or a verified OAuth principal.');
    this.#executor = new RelayAgentClient({
      baseUrl: process.env.OPERATOR_RELAY_CONTROL_URL?.trim() || 'http://127.0.0.1:8790',
      token: relayToken,
      ...(verifiedPrincipal ? { principal: verifiedPrincipal } : { accountId }),
      deviceId: verifiedPrincipal ? undefined : process.env.OPERATOR_RELAY_DEVICE_ID?.trim() || undefined,
      projectKey: verifiedPrincipal ? undefined : process.env.OPERATOR_RELAY_PROJECT_KEY?.trim() || undefined,
      waitMs: parseWait(process.env.OPERATOR_RELAY_WAIT_MS),
      publicBoundary: process.env.OPERATOR_MCP_PUBLIC_EDGE === '1' && process.env.OPERATOR_MCP_DEVELOPER_EDGE !== '1',
      developerBoundary: process.env.OPERATOR_MCP_DEVELOPER_EDGE === '1'
    });
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    return await this.#executor.execute(action);
  }

  async submitTask(input: TaskSubmitInput): Promise<TaskTransportResult> {
    return await this.#executor.submitTask(input);
  }

  async controlTask(taskId: string, operation: TaskControlOperation): Promise<TaskTransportResult> {
    return await this.#executor.controlTask(taskId, operation);
  }

  async submitOperation(input: OperationSubmitInput): Promise<OperationTransportResult> {
    return await this.#executor.submitOperation(input);
  }

  async controlOperation(operationId: string, operation: OperationControlOperation, verificationDigest?: string): Promise<OperationTransportResult> {
    return await this.#executor.controlOperation(operationId, operation, verificationDigest);
  }

  async inspectKnowledge(input: KnowledgeInspectInput): Promise<KnowledgeTransportResult> {
    return await this.#executor.inspectKnowledge(input);
  }

  async claimDevice(userCode: string, makeDefault = false): Promise<{ status: 'claimed' }> {
    if (!this.#executor.claimDevice) throw new Error('Device enrollment claim requires relay execution mode.');
    return await this.#executor.claimDevice(userCode, makeDefault);
  }
}

class DirectLocalAgentClient implements Executor {
  #url: URL;
  #baseUrl: URL;
  #token: string;

  constructor(baseUrl: string, token: string) {
    this.#url = validateLoopbackAgentUrl(baseUrl);
    this.#baseUrl = new URL('/', this.#url);
    if (token.length < 32) throw new Error('Local agent token must be at least 32 characters.');
    this.#token = token;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const response = await fetch(this.#url, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    const body = await response.json() as ActionResult;
    if (!response.ok && !body?.error) throw new Error(`Local agent HTTP ${response.status}`);
    return body;
  }

  async submitTask(input: TaskSubmitInput): Promise<TaskTransportResult> {
    return await this.#taskRequest(new URL('/v1/tasks', this.#baseUrl), 'POST', input);
  }

  async controlTask(taskId: string, operation: TaskControlOperation): Promise<TaskTransportResult> {
    const id = validTaskId(taskId);
    const suffix = operation === 'inspect' ? '' : `/${operation}`;
    return await this.#taskRequest(
      new URL(`/v1/tasks/${id}${suffix}`, this.#baseUrl),
      operation === 'inspect' ? 'GET' : 'POST',
      operation === 'resume' ? {} : undefined
    );
  }

  async submitOperation(input: OperationSubmitInput): Promise<OperationTransportResult> {
    const { resourceRequirements: _placementOnly, ...request } = input;
    return await this.#operationRequest(new URL('/v1/operations', this.#baseUrl), 'POST', request);
  }

  async controlOperation(operationId: string, operation: OperationControlOperation, verificationDigest?: string): Promise<OperationTransportResult> {
    const id = validTaskId(operationId);
    const suffix = operation === 'inspect' ? '' : `/${operation}`;
    return await this.#operationRequest(
      new URL(`/v1/operations/${id}${suffix}`, this.#baseUrl),
      operation === 'inspect' ? 'GET' : 'POST',
      operation === 'promote' ? { verificationDigest } : {}
    );
  }

  async inspectKnowledge(input: KnowledgeInspectInput): Promise<KnowledgeTransportResult> {
    if (input.kind === 'procedures') {
      return await this.#jsonRequest(new URL(`/v1/procedures?limit=${input.limit ?? 100}`, this.#baseUrl), 'GET');
    }
    if (input.kind === 'procedure-query') {
      return await this.#jsonRequest(new URL('/v1/procedures/query', this.#baseUrl), 'POST', input);
    }
    if (input.kind === 'optimizer') {
      return await this.#jsonRequest(new URL(`/v1/optimizer?limit=${input.limit ?? 200}`, this.#baseUrl), 'GET');
    }
    if (input.kind === 'world-list') {
      const url = new URL('/v1/world/entities', this.#baseUrl);
      if (input.scopeKey) url.searchParams.set('scopeKey', input.scopeKey);
      if (input.type) url.searchParams.set('type', input.type);
      url.searchParams.set('limit', String(input.limit ?? 100));
      return await this.#jsonRequest(url, 'GET');
    }
    const payload = input.kind === 'world-entity'
      ? { operation: 'entity', entityKey: input.entityKey }
      : input.kind === 'world-fact'
        ? { operation: 'fact', entityKey: input.entityKey, factKey: input.factKey }
        : input.kind === 'world-history'
          ? {
              operation: 'history',
              entityKey: input.entityKey,
              factKey: input.factKey,
              source: input.source,
              since: input.since,
              until: input.until,
              limit: input.limit
            }
          : {
              operation: 'trace',
              fromKey: input.fromKey,
              toKey: input.toKey,
              targetType: input.targetType,
              maxDepth: input.maxDepth,
              minConfidence: input.minConfidence
            };
    return await this.#jsonRequest(new URL('/v1/world/query', this.#baseUrl), 'POST', payload);
  }

  async #operationRequest(url: URL, method: 'GET' | 'POST', body?: unknown): Promise<OperationTransportResult> {
    const result = await this.#jsonRequest(url, method, body) as OperationTransportResult;
    if (typeof result.ok !== 'boolean') throw new Error('Local operation API returned malformed response.');
    return result;
  }

  async #taskRequest(url: URL, method: 'GET' | 'POST', body?: unknown): Promise<TaskTransportResult> {
    const response = await fetch(url, {
      redirect: 'error',
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${this.#token}`
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    const result = await response.json() as TaskTransportResult;
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error(`Local task API returned malformed HTTP ${response.status} response.`);
    }
    return result;
  }

  async #jsonRequest(url: URL, method: 'GET' | 'POST', body?: unknown): Promise<KnowledgeTransportResult> {
    const response = await fetch(url, {
      redirect: 'error',
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${this.#token}`
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    const result = await response.json() as KnowledgeTransportResult;
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error(`Local agent API returned malformed HTTP ${response.status} response.`);
    }
    return result;
  }
}

function validTaskId(input: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('taskId must be a UUID.');
  }
  return value;
}

export function validateLoopbackAgentUrl(input: string): URL {
  let base: URL;
  try { base = new URL(input); } catch { throw new Error('OPERATOR_AGENT_URL is invalid.'); }
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || base.username || base.password || base.hash || base.search) {
    throw new Error('OPERATOR_AGENT_URL must be credential-free loopback http:// without query or fragment.');
  }
  return new URL('/v1/execute', base);
}

function parseWait(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 10 * 60_000) {
    throw new Error('OPERATOR_RELAY_WAIT_MS must be an integer between 1000 and 600000.');
  }
  return parsed;
}
