import path from 'node:path';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { RelayClient, type RelayDelivery, type RelayRecoveryDecision, type RelaySocketFactory } from '../../../src/core/relay-client.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest } from '../../../src/core/types.ts';
import type { ApprovalAuthorityContext } from './approval-store.ts';
import { containsRestrictedData } from '../../../src/core/public-restricted-data.ts';
import { readRelaySessionTokenFile, type RelaySessionCredentialProvider } from './relay-session-credentials.ts';

const MAX_RESULT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface LocalAgentRelayRunnerOptions {
  stateDir: string;
  relayUrl: string;
  resultUrl?: string;
  sessionTokenFile: string;
  sessionCredentials?: RelaySessionCredentialProvider;
  identity: DeviceIdentityStore;
  localAgentBaseUrl: string;
  agentToken: string;
  supportedCapabilities?: readonly string[];
  getSupportedCapabilities?: () => Promise<readonly string[]>;
  allowLoopbackInsecure?: boolean;
  socketFactory?: RelaySocketFactory;
}

export class LocalAgentRelayRunner {
  #client: RelayClient;
  #identity: DeviceIdentityStore;
  #outbox: RelayResultStore;
  #sessionCredentials: RelaySessionCredentialProvider;
  #resultUrl: string;
  #localAgentBaseUrl: string;
  #localExecuteUrl: string;
  #agentToken: string;

  constructor(options: LocalAgentRelayRunnerOptions) {
    this.#identity = options.identity;
    this.#outbox = new RelayResultStore(path.join(path.resolve(options.stateDir), 'relay-outbox'));
    const legacyFile = path.resolve(options.sessionTokenFile);
    this.#sessionCredentials = options.sessionCredentials ?? {
      forConnection: () => readRelaySessionTokenFile(legacyFile),
      forRequest: () => readRelaySessionTokenFile(legacyFile),
      stop: () => undefined
    };
    this.#resultUrl = validateResultUrl(options.resultUrl ?? deriveResultUrl(options.relayUrl), options.relayUrl, Boolean(options.allowLoopbackInsecure));
    this.#localAgentBaseUrl = ensureHttpBase(options.localAgentBaseUrl);
    this.#localExecuteUrl = new URL('/v1/execute', this.#localAgentBaseUrl).toString();
    this.#agentToken = options.agentToken;
    this.#client = new RelayClient({
      stateDir: options.stateDir,
      url: options.relayUrl,
      identity: options.identity,
      socketFactory: options.socketFactory,
      allowLoopbackInsecureWs: Boolean(options.allowLoopbackInsecure),
      getSessionToken: () => this.#sessionCredentials.forConnection(),
      supportedCapabilities: options.supportedCapabilities,
      getSupportedCapabilities: options.getSupportedCapabilities,
      onDelivery: (delivery) => this.#handleDelivery(delivery),
      onRecovery: (context) => this.#recoverStoredResult(context.delivery.seq, context.delivery.id, context.delivery),
      onExpiredRecovery: (context) => this.#recoverStoredResult(context.processing.seq, context.processing.id),
      onAcknowledged: (delivery) => this.#discardStoredResult(delivery.seq, delivery.id)
    });
  }

  run(): Promise<void> { return this.#client.run(); }
  stop(): void { this.#client.stop(); this.#sessionCredentials.stop(); }
  reconnect(): void { this.#client.reconnect(); }
  state(): ReturnType<RelayClient['state']> { return this.#client.state(); }

  async #handleDelivery(delivery: RelayDelivery): Promise<void> {
    const identity = await this.#identity.loadOrCreate();
    const result = delivery.kind === 'action'
      ? await this.#executeActionPayload(delivery.payload)
      : delivery.kind === 'task'
        ? await this.#executeTaskPayload(delivery.payload)
        : { ok: false, error: { code: 'RELAY_DELIVERY_KIND_UNSUPPORTED', message: `Unsupported relay delivery kind ${delivery.kind}.` } };
    const safe = boundedResult(result);
    await this.#outbox.put(identity.deviceId, delivery.seq, delivery.id, safe);
    await this.#submitResult(delivery.seq, delivery.id, safe);
  }

  async #recoverStoredResult(seq: number, deliveryId: string, delivery?: RelayDelivery): Promise<RelayRecoveryDecision> {
    const identity = await this.#identity.loadOrCreate();
    const stored = await this.#outbox.get(identity.deviceId, seq);
    if (!stored || stored.deliveryId !== deliveryId) return delivery && canRetryUncertainRelayDelivery(delivery) ? 'retry' : 'stop';
    await this.#submitResult(seq, deliveryId, stored.result);
    return 'ack';
  }

  async #discardStoredResult(seq: number, deliveryId: string): Promise<void> {
    const identity = await this.#identity.loadOrCreate();
    await this.#outbox.removeExact(identity.deviceId, seq, deliveryId);
  }

  async #executeActionPayload(payload: JsonObject): Promise<JsonObject> {
    const action = validateRemoteAction(payload.action);
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const publicBoundary = payload.publicBoundary === true;
    if (publicBoundary && containsRestrictedData(action.input)) return restrictedDataBlockedResult(action.capability);
    const response = await fetch(this.#localExecuteUrl, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#agentToken}`
      },
      body: JSON.stringify({ action, ...(approvalAuthority ? { approvalAuthority } : {}) })
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Local agent returned a non-JSON execution response.', { retryable: false }); }
    if (publicBoundary && containsRestrictedData(body)) return restrictedDataBlockedResult(action.capability);
    if (![200, 409, 423].includes(response.status)) {
      throw new OperatorError('RELAY_LOCAL_EXECUTION_UNCERTAIN', `Local agent returned HTTP ${response.status}; execution state cannot be safely inferred.`, { retryable: false });
    }
    return boundedResult(body);
  }

  async #executeTaskPayload(payload: JsonObject): Promise<JsonObject> {
    const task = validateRelayTaskRequest(payload.task);
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    if (task.operation === 'submit') {
      return await this.#callTaskApi('/v1/tasks', 'POST', { ...task.request, approvalAuthority });
    }

    const path = `/v1/tasks/${task.taskId}`;
    const current = await this.#callTaskApi(path, 'GET');
    if (!current.ok || task.operation === 'inspect') return current;
    const state = current.task && typeof current.task === 'object' ? String((current.task as Record<string, unknown>).state ?? '') : '';
    if (task.operation === 'pause' && state === 'PAUSED') return current;
    if (task.operation === 'cancel' && state === 'CANCELLED') return current;
    if (task.operation === 'run' && ['VERIFIED', 'FAILED', 'CANCELLED'].includes(state)) return current;
    if (task.operation === 'resume' && ['VERIFIED', 'FAILED'].includes(state)) return current;
    return await this.#callTaskApi(`${path}/${task.operation}`, 'POST', { approvalAuthority });
  }

  async #callTaskApi(pathname: string, method: 'GET' | 'POST', body?: unknown): Promise<JsonObject> {
    const response = await fetch(new URL(pathname, this.#localAgentBaseUrl), {
      redirect: 'error', method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.#agentToken}` },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
    });
    let bodyValue: unknown;
    try { bodyValue = await response.json(); }
    catch { throw new OperatorError('RELAY_LOCAL_TASK_RESULT_INVALID', 'Local agent returned a non-JSON durable task response.', { retryable: false }); }
    if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue) || typeof (bodyValue as Record<string, unknown>).ok !== 'boolean') {
      throw new OperatorError('RELAY_LOCAL_TASK_RESULT_INVALID', 'Local agent returned a malformed durable task response.', { retryable: false });
    }
    if (![200, 202, 400, 403, 404, 409, 423, 503].includes(response.status)) {
      throw new OperatorError('RELAY_LOCAL_TASK_UNCERTAIN', `Local task API returned HTTP ${response.status}; durable task state must be reconciled before retry.`, { retryable: true });
    }
    return boundedResult(bodyValue);
  }

  async #submitResult(seq: number, deliveryId: string, result: JsonObject): Promise<void> {
    const token = await this.#sessionCredentials.forRequest();
    let response: Response;
    try {
      response = await fetch(this.#resultUrl, {
        redirect: 'error',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ seq, deliveryId, result })
      });
    } catch (error) {
      throw new OperatorError('RELAY_RESULT_SUBMIT_FAILED', `Relay result submission failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    if (response.status === 200) return;
    let code = 'RELAY_RESULT_SUBMIT_FAILED';
    try { code = String((await response.json() as any)?.error?.code ?? code); } catch { /* bounded generic failure */ }
    const retryable = response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500;
    throw new OperatorError(code, `Relay result service rejected result with HTTP ${response.status}.`, { retryable });
  }


}

export { readRelaySessionTokenFile } from './relay-session-credentials.ts';

export function canRetryUncertainRelayDelivery(delivery: RelayDelivery): boolean {
  try {
    if (delivery.kind === 'task') { validateRelayTaskRequest(delivery.payload.task); return true; }
    if (delivery.kind === 'action') return validateRemoteAction(delivery.payload.action).risk === 'read';
    return false;
  } catch {
    return false;
  }
}

type RelayTaskRequest =
  | { operation: 'submit'; request: Record<string, unknown> }
  | { operation: 'inspect' | 'run' | 'pause' | 'resume' | 'cancel'; taskId: string };

function validateRelayTaskRequest(input: unknown): RelayTaskRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task payload must be an object.');
  const raw = input as Record<string, unknown>;
  const operation = String(raw.operation ?? '');
  if (operation === 'submit') {
    if (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request)) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task submit payload requires a request object.');
    const request = structuredClone(raw.request as Record<string, unknown>);
    request.requestId = validTaskUuid(request.requestId, 'requestId');
    if (!request.goal || typeof request.goal !== 'object' || Array.isArray(request.goal)) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task submit payload requires a goal object.');
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task submit payload exceeds the bounded size.');
    return { operation: 'submit', request };
  }
  if (!['inspect', 'run', 'pause', 'resume', 'cancel'].includes(operation)) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task operation is invalid.');
  if (raw.approvedActionId !== undefined) throw new OperatorError('RELAY_TASK_INVALID', 'Relay task control cannot carry local approval authority.');
  return { operation: operation as 'inspect' | 'run' | 'pause' | 'resume' | 'cancel', taskId: validTaskUuid(raw.taskId, 'taskId') };
}

function validTaskUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('RELAY_TASK_INVALID', `Relay task ${label} must be a UUID.`);
  return value;
}

function validateRemoteAction(input: unknown): ActionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action payload must contain an action object.');
  const raw = input as Record<string, unknown>;
  const id = boundedName(raw.id, 'action id');
  const capability = boundedName(raw.capability, 'capability');
  const risk = raw.risk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(String(risk))) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action input must be an object.');
  const inputText = JSON.stringify(raw.input);
  if (Buffer.byteLength(inputText, 'utf8') > 128 * 1024) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action input exceeds the bounded size.');
  if (!raw.provenance || typeof raw.provenance !== 'object' || Array.isArray(raw.provenance) || (raw.provenance as any).kind !== 'chatgpt') {
    throw new OperatorError('RELAY_ACTION_PROVENANCE_INVALID', 'Remote relay actions must carry ChatGPT instruction provenance.');
  }
  const taskId = raw.taskId === undefined ? undefined : boundedName(raw.taskId, 'task id');
  const target = raw.target === undefined ? undefined : boundedText(raw.target, 'target', 2048);
  return {
    id,
    capability,
    risk: risk as ActionRequest['risk'],
    input: structuredClone(raw.input as Record<string, unknown>),
    provenance: { kind: 'chatgpt', source: (raw.provenance as any).source === undefined ? undefined : boundedText((raw.provenance as any).source, 'provenance source', 512) },
    taskId,
    target
  };
}

function validateApprovalAuthority(input: unknown): ApprovalAuthorityContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('RELAY_APPROVAL_AUTHORITY_INVALID', 'Relay approval authority is invalid.');
  }
  const raw = input as Record<string, unknown>;
  const accountId = String(raw.accountId ?? '');
  const deviceId = String(raw.deviceId ?? '');
  const generation = Number(raw.generation);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(accountId) || !uuid.test(deviceId) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new OperatorError('RELAY_APPROVAL_AUTHORITY_INVALID', 'Relay approval authority is invalid.');
  }
  return { accountId: accountId.toLowerCase(), deviceId: deviceId.toLowerCase(), generation };
}

function restrictedDataBlockedResult(capability: string): JsonObject {
  return {
    ok: false,
    capability,
    provider: 'public-boundary',
    error: {
      code: 'RESTRICTED_DATA_BLOCKED',
      message: 'The public plugin refused content that may contain restricted data.'
    },
    evidence: [],
    durationMs: 0
  };
}

function boundedResult(input: unknown): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Relay action result must be a JSON object.');
  let text: string;
  try { text = JSON.stringify(input); } catch { throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Relay action result is not JSON serializable.'); }
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new OperatorError('RELAY_LOCAL_RESULT_TOO_LARGE', 'Relay action result exceeds the bounded result size.');
  return JSON.parse(text) as JsonObject;
}

function boundedName(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new OperatorError('RELAY_ACTION_INVALID', `Relay ${label} is invalid.`);
  return value;
}

function boundedText(input: unknown, label: string, max: number): string {
  const value = String(input ?? '');
  if (!value || Buffer.byteLength(value, 'utf8') > max) throw new OperatorError('RELAY_ACTION_INVALID', `Relay ${label} is invalid.`);
  return value;
}

function deriveResultUrl(relayUrlInput: string): string {
  let relay: URL;
  try { relay = new URL(relayUrlInput); } catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  relay.protocol = relay.protocol === 'wss:' ? 'https:' : relay.protocol === 'ws:' ? 'http:' : relay.protocol;
  relay.pathname = '/v1/device-result'; relay.search = ''; relay.hash = '';
  return relay.toString();
}

function validateResultUrl(input: string, relayUrlInput: string, allowLoopbackInsecure: boolean): string {
  let url: URL;
  let relay: URL;
  try { url = new URL(input); } catch { throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL is invalid.'); }
  try { relay = new URL(relayUrlInput); } catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  if (url.username || url.password || url.hash || url.search) throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL must not contain credentials, a query, or a fragment.');
  if (url.pathname !== '/v1/device-result') throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL must use the fixed /v1/device-result endpoint.');

  const localOverride = allowLoopbackInsecure && isLoopback(url.hostname) && isLoopback(relay.hostname);
  if (localOverride && ['http:', 'https:'].includes(url.protocol)) return url.toString();

  const expected = new URL(deriveResultUrl(relayUrlInput));
  if (url.protocol === 'https:' && expected.protocol === 'https:' && url.origin === expected.origin && url.pathname === expected.pathname) {
    return url.toString();
  }
  if (url.protocol !== 'https:') throw new OperatorError('RELAY_RESULT_TLS_REQUIRED', 'Relay results require HTTPS; insecure HTTP is allowed only for explicit loopback development.');
  throw new OperatorError('RELAY_RESULT_AUTHORITY_MISMATCH', 'Relay result URL must remain on the relay-authorized HTTPS origin.');
}

function ensureHttpBase(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new OperatorError('RELAY_LOCAL_AGENT_URL_INVALID', 'Local agent base URL is invalid.'); }
  if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username || url.password) throw new OperatorError('RELAY_LOCAL_AGENT_URL_INVALID', 'Relay runner may call only a loopback HTTP local-agent endpoint.');
  return url.toString();
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}
