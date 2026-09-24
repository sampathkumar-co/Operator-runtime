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

type Executor = {
  execute(action: ActionRequest): Promise<ActionResult>;
  submitTask(input: TaskSubmitInput): Promise<TaskTransportResult>;
  controlTask(taskId: string, operation: TaskControlOperation): Promise<TaskTransportResult>;
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
    return await this.#taskRequest(new URL(`/v1/tasks/${id}${suffix}`, this.#baseUrl), operation === 'inspect' ? 'GET' : 'POST', operation === 'resume' ? {} : undefined);
  }

  async #taskRequest(url: URL, method: 'GET' | 'POST', body?: unknown): Promise<TaskTransportResult> {
    const response = await fetch(url, {
      redirect: 'error', method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.#token}` },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    const result = await response.json() as TaskTransportResult;
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error(`Local task API returned malformed HTTP ${response.status} response.`);
    return result;
  }
}

function validTaskId(input: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('taskId must be a UUID.');
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
