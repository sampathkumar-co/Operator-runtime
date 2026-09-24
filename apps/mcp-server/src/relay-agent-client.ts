import type { AccountPrincipal } from '../../../src/core/account-device-registry.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';
import type { TaskControlOperation, TaskSubmitInput, TaskTransportResult } from './local-agent-client.ts';
import { currentMcpTaskId } from './request-context.ts';

const MAX_TIMEOUT_MS = 10 * 60_000;

export interface RelayAgentClientOptions {
  baseUrl: string;
  token: string;
  accountId?: string;
  principal?: AccountPrincipal;
  deviceId?: string;
  projectKey?: string;
  waitMs?: number;
  publicBoundary?: boolean;
  developerBoundary?: boolean;
}

export class RelayAgentClient {
  #url: URL;
  #token: string;
  #accountId?: string;
  #principal?: AccountPrincipal;
  #deviceId?: string;
  #projectKey?: string;
  #waitMs: number;
  #publicBoundary: boolean;
  #developerBoundary: boolean;

  constructor(options: RelayAgentClientOptions) {
    this.#url = validateLoopbackControlUrl(options.baseUrl);
    if (options.token.length < 32) throw new Error('Relay control token must be at least 32 characters.');
    this.#token = options.token;
    if (Boolean(options.accountId) === Boolean(options.principal)) throw new Error('Relay execution requires exactly one accountId or verified principal.');
    this.#accountId = options.accountId ? validUuid(options.accountId, 'OPERATOR_RELAY_ACCOUNT_ID') : undefined;
    this.#principal = options.principal ? validPrincipal(options.principal) : undefined;
    this.#deviceId = options.deviceId ? validUuid(options.deviceId, 'OPERATOR_RELAY_DEVICE_ID') : undefined;
    this.#projectKey = options.projectKey ? validProjectKey(options.projectKey) : undefined;
    const waitMs = options.waitMs ?? MAX_TIMEOUT_MS;
    if (!Number.isInteger(waitMs) || waitMs < 1_000 || waitMs > MAX_TIMEOUT_MS) throw new Error(`Relay wait must be between 1000 and ${MAX_TIMEOUT_MS} ms.`);
    this.#waitMs = waitMs;
    this.#publicBoundary = options.publicBoundary === true;
    this.#developerBoundary = options.developerBoundary === true;
    if (this.#publicBoundary && this.#developerBoundary) throw new Error('Relay client cannot be both public and developer boundary.');
  }

  async claimDevice(userCodeInput: string): Promise<{ status: 'claimed' }> {
    const userCode = validUserCode(userCodeInput);
    const response = await fetch(new URL('/v1/device-enrollment/claim', this.#url), {
      redirect: 'error', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ ...(this.#accountId ? { accountId: this.#accountId } : {}), ...(this.#principal ? { principal: this.#principal } : {}), userCode }),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json() as any;
    if (!response.ok || body?.ok !== true || body?.enrollment?.status !== 'claimed') {
      throw new OperatorError(typeof body?.error?.code === 'string' ? body.error.code : 'DEVICE_ENROLLMENT_CLAIM_FAILED', 'Device enrollment claim was not accepted.');
    }
    return { status: 'claimed' };
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const taskId = action.taskId ?? currentMcpTaskId();
    const outboundAction = taskId ? { ...action, taskId } : action;
    const response = await fetch(this.#url, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`
      },
      body: JSON.stringify({
        ...(this.#accountId ? { accountId: this.#accountId } : {}),
        ...(this.#principal ? { principal: this.#principal } : {}),
        ...(this.#deviceId ? { deviceId: this.#deviceId } : {}),
        ...(this.#projectKey ? { projectKey: this.#projectKey } : {}),
        ...(this.#publicBoundary ? { publicBoundary: true } : {}),
        ...(this.#developerBoundary ? { developerBoundary: true } : {}),
        action: outboundAction,
        waitMs: this.#waitMs
      }),
      signal: AbortSignal.timeout(this.#waitMs + 5_000)
    });
    const body = await response.json() as ActionResult;
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean' || !Array.isArray(body.evidence) || typeof body.provider !== 'string') {
      throw new Error(`Relay control returned malformed HTTP ${response.status} response.`);
    }
    return body;
  }

  async submitTask(input: TaskSubmitInput): Promise<TaskTransportResult> {
    return await this.#taskRequest({ operation: 'submit', request: input });
  }

  async controlTask(taskId: string, operation: TaskControlOperation): Promise<TaskTransportResult> {
    return await this.#taskRequest({ operation, taskId: validUuid(taskId, 'taskId') });
  }

  async #taskRequest(task: Record<string, unknown>): Promise<TaskTransportResult> {
    const response = await fetch(new URL('/v1/task', this.#url), {
      redirect: 'error', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({
        ...(this.#accountId ? { accountId: this.#accountId } : {}),
        ...(this.#principal ? { principal: this.#principal } : {}),
        ...(this.#deviceId ? { deviceId: this.#deviceId } : {}),
        ...(this.#projectKey ? { projectKey: this.#projectKey } : {}),
        ...(this.#developerBoundary ? { developerBoundary: true } : {}),
        task,
        waitMs: this.#waitMs
      }),
      signal: AbortSignal.timeout(this.#waitMs + 5_000)
    });
    const body = await response.json() as TaskTransportResult;
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
      throw new Error(`Relay task control returned malformed HTTP ${response.status} response.`);
    }
    return body;
  }
}

function validateLoopbackControlUrl(input: string): URL {
  let base: URL;
  try { base = new URL(input); } catch { throw new Error('OPERATOR_RELAY_CONTROL_URL is invalid.'); }
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || base.username || base.password || base.hash) {
    throw new Error('Relay control URL must be credential-free loopback http://.');
  }
  return new URL('/v1/execute', base);
}

function validPrincipal(input: AccountPrincipal): AccountPrincipal {
  const issuer = String(input?.issuer ?? '').trim();
  const subject = String(input?.subject ?? '').trim();
  if (!issuer || issuer.length > 1024 || /[\0\r\n]/.test(issuer)) throw new Error('Relay principal issuer is invalid.');
  if (!subject || subject.length > 1024 || /[\0\r\n]/.test(subject)) throw new Error('Relay principal subject is invalid.');
  return { issuer, subject };
}

function validUuid(value: string, name: string): string {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${name} must be a UUID.`);
  return text.toLowerCase();
}

function validProjectKey(value: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error('OPERATOR_RELAY_PROJECT_KEY is invalid.');
  return text;
}

function validUserCode(input: string): string {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) throw new OperatorError('DEVICE_ENROLLMENT_CODE_INVALID', 'Device enrollment code is invalid or expired.');
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
