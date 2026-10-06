import path from 'node:path';
import os from 'node:os';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { RelayClient, type RelayClientStatus, type RelayConnectionState, type RelayDelivery, type RelayExpiredRecoveryDecision, type RelayRecoveryDecision, type RelaySocketFactory } from '../../../src/core/relay-client.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest } from '../../../src/core/types.ts';
import type { ApprovalAuthorityContext } from './approval-store.ts';
import { containsRestrictedData } from '../../../src/core/public-restricted-data.ts';
import { readRelaySessionTokenFile, type RelaySessionCredentialProvider } from './relay-session-credentials.ts';

const MAX_RESULT_BYTES = 256 * 1024;
const RESULT_SUBMIT_ATTEMPTS = 3;
const RESULT_SUBMIT_RETRY_BASE_MS = 150;
const RESULT_SUBMIT_RETRY_MAX_MS = 750;
const LOCAL_ACTION_DEFAULT_TIMEOUT_MS = 2 * 60_000;
const LOCAL_ACTION_MAX_TIMEOUT_MS = 10 * 60_000;
const LOCAL_ACTION_RECEIPT_TIMEOUT_MS = 10_000;
const LOCAL_ACTION_RECEIPT_RECOVERY_WINDOW_MS = 5_000;
const RESULT_SUBMIT_TIMEOUT_MS = 30_000;

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
  onStatus?: (status: RelayClientStatus) => void;
  onConnectionState?: (status: RelayConnectionState) => void;
  localRequestTimeoutMs?: number;
  resultSubmitTimeoutMs?: number;
}

export class LocalAgentRelayRunner {
  #client: RelayClient;
  #identity: DeviceIdentityStore;
  #outbox: RelayResultStore;
  #sessionCredentials: RelaySessionCredentialProvider;
  #resultUrl: string;
  #localAgentBaseUrl: string;
  #localExecuteUrl: string;
  #localActionReceiptUrl: string;
  #agentToken: string;
  #localRequestTimeoutMs: number;
  #resultSubmitTimeoutMs: number;

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
    this.#localActionReceiptUrl = new URL('/v1/action-receipt', this.#localAgentBaseUrl).toString();
    this.#agentToken = options.agentToken;
    this.#localRequestTimeoutMs = boundedLocalRequestTimeout(options.localRequestTimeoutMs ?? LOCAL_ACTION_DEFAULT_TIMEOUT_MS);
    this.#resultSubmitTimeoutMs = boundedResultSubmitTimeout(options.resultSubmitTimeoutMs ?? RESULT_SUBMIT_TIMEOUT_MS);
    this.#client = new RelayClient({
      stateDir: options.stateDir,
      url: options.relayUrl,
      identity: options.identity,
      socketFactory: options.socketFactory,
      allowLoopbackInsecureWs: Boolean(options.allowLoopbackInsecure),
      getSessionToken: () => this.#sessionCredentials.forConnection(),
      supportedCapabilities: options.supportedCapabilities,
      getSupportedCapabilities: options.getSupportedCapabilities,
      resourceProfile: localResourceProfile(),
      onStatus: options.onStatus,
      onConnectionState: options.onConnectionState,
      onDelivery: (delivery) => this.#handleDelivery(delivery),
      onRecovery: (context) => this.#recoverStoredResult(context.delivery.seq, context.delivery.id, context.delivery),
      onExpiredRecovery: (context) => this.#recoverExpiredStoredResult(context.processing.seq, context.processing.id),
      onAcknowledged: (delivery) => this.#discardStoredResult(delivery.seq, delivery.id)
    });
  }

  run(): Promise<void> { return this.#client.run(); }
  stop(): void { this.#client.stop(); this.#sessionCredentials.stop(); }
  reconnect(): void { this.#client.reconnect(); }
  state(): ReturnType<RelayClient['state']> { return this.#client.state(); }

  async #handleDelivery(delivery: RelayDelivery): Promise<void> {
    const identity = await this.#identity.loadOrCreate();
    const stored = await this.#outbox.get(identity.deviceId, delivery.seq);
    if (stored) {
      if (stored.deliveryId !== delivery.id || !stored.result) {
        throw new OperatorError('RELAY_RESULT_CONFLICT', 'A durable relay result exists for this sequence but does not match the replayed delivery.');
      }
      await this.#submitResultWithRetry(delivery.seq, delivery.id, stored.result);
      return;
    }
    let safe: JsonObject;
    try {
      const result = delivery.kind === 'action'
        ? await this.#executeActionPayload(delivery.payload)
        : delivery.kind === 'task'
          ? await this.#executeTaskPayload(delivery.payload)
          : delivery.kind === 'operation'
            ? await this.#executeOperationPayload(delivery.payload)
            : delivery.kind === 'knowledge'
              ? await this.#executeKnowledgePayload(delivery.payload)
              : { ok: false, error: { code: 'RELAY_DELIVERY_KIND_UNSUPPORTED', message: `Unsupported relay delivery kind ${delivery.kind}.` } };
      safe = boundedResult(result);
    } catch (error) {
      safe = oversizedRelayResultFallback(error, delivery);
    }
    await this.#outbox.put(identity.deviceId, delivery.seq, delivery.id, safe);
    await this.#submitResultWithRetry(delivery.seq, delivery.id, safe);
  }

  async #recoverStoredResult(seq: number, deliveryId: string, delivery?: RelayDelivery): Promise<RelayRecoveryDecision> {
    const identity = await this.#identity.loadOrCreate();
    const stored = await this.#outbox.get(identity.deviceId, seq);
    if (stored && stored.deliveryId === deliveryId) {
      if (!stored.result) {
        throw new OperatorError('RELAY_RESULT_CORRUPT', 'Durable relay result record is missing its bounded result payload.');
      }
      await this.#submitResultWithRetry(seq, deliveryId, stored.result);
      return 'ack';
    }
    if (delivery?.kind === 'action') {
      const recovered = await this.#recoverLocalActionReceipt(delivery.payload);
      if (recovered.state === 'completed') {
        const safe = boundedResult(recovered.result);
        await this.#outbox.put(identity.deviceId, seq, deliveryId, safe);
        await this.#submitResultWithRetry(seq, deliveryId, safe);
        return 'ack';
      }
      if (recovered.state === 'processing') return 'stop';
    }
    return delivery && canRetryUncertainRelayDelivery(delivery) ? 'retry' : 'stop';
  }

  async #recoverExpiredStoredResult(seq: number, deliveryId: string): Promise<RelayExpiredRecoveryDecision> {
    const decision = await this.#recoverStoredResult(seq, deliveryId);
    return decision === 'ack' ? 'ack' : 'stop';
  }

  async #discardStoredResult(seq: number, deliveryId: string): Promise<void> {
    const identity = await this.#identity.loadOrCreate();
    await this.#outbox.removeExact(identity.deviceId, seq, deliveryId);
  }

  async #recoverLocalActionReceipt(payload: JsonObject): Promise<{ state: 'missing' } | { state: 'processing' } | { state: 'completed'; result: JsonObject }> {
    const action = validateRemoteAction(payload.action);
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const enterpriseContext = validateRelayEnterpriseContext(payload.enterpriseContext, approvalAuthority);
    const deadline = Date.now() + LOCAL_ACTION_RECEIPT_RECOVERY_WINDOW_MS;
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await fetchWithDeadline(this.#localActionReceiptUrl, {
          redirect: 'error',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#agentToken}`,
            ...relayRequestHeaders(enterpriseContext)
          },
          body: JSON.stringify({ action, ...(approvalAuthority ? { approvalAuthority } : {}) })
        }, Math.min(LOCAL_ACTION_RECEIPT_TIMEOUT_MS, Math.max(50, deadline - Date.now())), 'local action receipt');
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'RELAY_LOCAL_HTTP_TIMEOUT') return { state: 'processing' };
        throw error;
      }
      let body: any;
      try { body = await response.json(); }
      catch { throw new OperatorError('RELAY_LOCAL_RECEIPT_INVALID', 'Local action receipt endpoint returned non-JSON data.', { retryable: true }); }
      if (response.status === 404) return { state: 'missing' };
      if (response.status === 202) {
        if (Date.now() >= deadline) return { state: 'processing' };
        const delay = Math.min(750, 100 * 2 ** Math.min(attempt++, 3), Math.max(1, deadline - Date.now()));
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (response.status !== 200) {
        const code = typeof body?.error?.code === 'string' ? body.error.code : 'RELAY_LOCAL_RECEIPT_FAILED';
        throw new OperatorError(code, `Local action receipt lookup failed with HTTP ${response.status}.`, { retryable: response.status >= 500 });
      }
      if (!body?.receipt) return { state: 'missing' };
      if (body.receipt.status !== 'completed') return { state: 'processing' };
      if (payload.publicBoundary === true && containsRestrictedData(body.result)) return { state: 'completed', result: restrictedDataBlockedResult(action.capability) };
      return { state: 'completed', result: boundedResult(body.result) };
    }
  }

  async #executeActionPayload(payload: JsonObject): Promise<JsonObject> {
    const action = validateRemoteAction(payload.action);
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const enterpriseContext = validateRelayEnterpriseContext(payload.enterpriseContext, approvalAuthority);
    const publicBoundary = payload.publicBoundary === true;
    if (publicBoundary && containsRestrictedData(action.input)) return restrictedDataBlockedResult(action.capability);
    let response: Response;
    try {
      response = await fetchWithDeadline(this.#localExecuteUrl, {
        redirect: 'error',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#agentToken}`,
          ...relayRequestHeaders(enterpriseContext)
        },
        body: JSON.stringify({ action, ...(approvalAuthority ? { approvalAuthority } : {}) })
      }, actionRequestTimeoutMs(action, this.#localRequestTimeoutMs), 'local action execution');
    } catch (error) {
      const recovered = await this.#recoverLocalActionReceipt(payload);
      if (recovered.state === 'completed') return recovered.result;
      throw new OperatorError('RELAY_LOCAL_EXECUTION_UNCERTAIN', `Local action request did not complete cleanly: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        details: { actionId: action.id, sideEffectState: 'uncertain' }
      });
    }
    let body: any;
    try { body = await response.json(); }
    catch { throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Local agent returned a non-JSON execution response.', { retryable: false }); }
    if (response.status === 409 && body?.error?.code === 'ACTION_EXECUTION_IN_PROGRESS') {
      const recovered = await this.#recoverLocalActionReceipt(payload);
      if (recovered.state === 'completed') return recovered.result;
      throw new OperatorError('RELAY_LOCAL_EXECUTION_UNCERTAIN', 'Local action has a durable in-progress receipt and will not be replayed blindly.', {
        retryable: true,
        details: { actionId: action.id, sideEffectState: 'uncertain' }
      });
    }
    if (publicBoundary && containsRestrictedData(body)) return restrictedDataBlockedResult(action.capability);
    if (![200, 409, 423].includes(response.status)) {
      throw new OperatorError('RELAY_LOCAL_EXECUTION_UNCERTAIN', `Local agent returned HTTP ${response.status}; execution state cannot be safely inferred.`, { retryable: true });
    }
    return boundedResult(body);
  }

  async #executeTaskPayload(payload: JsonObject): Promise<JsonObject> {
    const task = validateRelayTaskRequest(payload.task);
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const enterpriseContext = validateRelayEnterpriseContext(payload.enterpriseContext, approvalAuthority);
    if (task.operation === 'submit') {
      return await this.#callTaskApi('/v1/tasks', 'POST', { ...task.request, approvalAuthority }, enterpriseContext);
    }

    const path = `/v1/tasks/${task.taskId}`;
    const current = await this.#callTaskApi(path, 'GET', undefined, enterpriseContext);
    if (!current.ok || task.operation === 'inspect') return current;
    const state = current.task && typeof current.task === 'object' ? String((current.task as Record<string, unknown>).state ?? '') : '';
    if (task.operation === 'pause' && state === 'PAUSED') return current;
    if (task.operation === 'cancel' && state === 'CANCELLED') return current;
    if (task.operation === 'run' && ['VERIFIED', 'FAILED', 'CANCELLED'].includes(state)) return current;
    if (task.operation === 'resume' && ['VERIFIED', 'FAILED'].includes(state)) return current;
    return await this.#callTaskApi(`${path}/${task.operation}`, 'POST', { approvalAuthority }, enterpriseContext);
  }

  async #executeKnowledgePayload(payload: JsonObject): Promise<JsonObject> {
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const enterpriseContext = validateRelayEnterpriseContext(payload.enterpriseContext, approvalAuthority);
    const query = validateRelayKnowledgeQuery(payload.query);
    if (query.kind === 'procedures') return await this.#callOperationApi(`/v1/procedures?limit=${query.limit}`, 'GET', undefined, enterpriseContext);
    if (query.kind === 'procedure-query') return await this.#callOperationApi('/v1/procedures/query', 'POST', query, enterpriseContext);
    if (query.kind === 'optimizer') return await this.#callOperationApi(`/v1/optimizer?limit=${query.limit}`, 'GET', undefined, enterpriseContext);
    if (query.kind === 'world-list') {
      const url = new URL('/v1/world/entities', this.#localAgentBaseUrl);
      if (query.scopeKey) url.searchParams.set('scopeKey', query.scopeKey);
      if (query.type) url.searchParams.set('type', query.type);
      url.searchParams.set('limit', String(query.limit));
      return await this.#callAbsoluteOperationApi(url, 'GET', undefined, enterpriseContext);
    }
    if (query.kind === 'world-entity') return await this.#callOperationApi('/v1/world/query', 'POST', { operation: 'entity', entityKey: query.entityKey }, enterpriseContext);
    if (query.kind === 'world-fact') return await this.#callOperationApi('/v1/world/query', 'POST', { operation: 'fact', entityKey: query.entityKey, factKey: query.factKey }, enterpriseContext);
    return await this.#callOperationApi('/v1/world/query', 'POST', {
      operation: 'trace', fromKey: query.fromKey, toKey: query.toKey, targetType: query.targetType,
      maxDepth: query.maxDepth, minConfidence: query.minConfidence
    }, enterpriseContext);
  }

  async #callAbsoluteOperationApi(url: URL, method: 'GET' | 'POST', body?: unknown, enterpriseContext?: RelayEnterpriseContext): Promise<JsonObject> {
    const response = await fetchWithDeadline(url.toString(), {
      redirect: 'error', method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.#agentToken}`, ...relayRequestHeaders(enterpriseContext) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
    }, this.#localRequestTimeoutMs, 'local knowledge/operation request');
    let bodyValue: unknown;
    try { bodyValue = await response.json(); }
    catch { throw new OperatorError('RELAY_LOCAL_KNOWLEDGE_RESULT_INVALID', 'Local agent returned a non-JSON knowledge response.', { retryable: false }); }
    if (!bodyValue || typeof bodyValue !== 'object' || Array.isArray(bodyValue) || typeof (bodyValue as Record<string, unknown>).ok !== 'boolean') {
      throw new OperatorError('RELAY_LOCAL_KNOWLEDGE_RESULT_INVALID', 'Local agent returned a malformed knowledge response.', { retryable: false });
    }
    if (![200, 400, 404, 503].includes(response.status)) {
      throw new OperatorError('RELAY_LOCAL_KNOWLEDGE_UNCERTAIN', `Local knowledge API returned HTTP ${response.status}.`, { retryable: true });
    }
    return boundedResult(bodyValue);
  }

  async #executeOperationPayload(payload: JsonObject): Promise<JsonObject> {
    const approvalAuthority = validateApprovalAuthority(payload.approvalAuthority);
    const enterpriseContext = validateRelayEnterpriseContext(payload.enterpriseContext, approvalAuthority);
    const request = validateRelayOperationRequest(payload.operation);
    if (request.operation === 'submit') {
      return await this.#callOperationApi('/v1/operations', 'POST', request.request, enterpriseContext);
    }
    const pathname = `/v1/operations/${request.operationId}`;
    if (request.operation === 'inspect') return await this.#callOperationApi(pathname, 'GET', undefined, enterpriseContext);
    const body = request.operation === 'promote' ? { verificationDigest: request.verificationDigest } : {};
    return await this.#callOperationApi(`${pathname}/${request.operation}`, 'POST', body, enterpriseContext);
  }

  async #callOperationApi(pathname: string, method: 'GET' | 'POST', body?: unknown, enterpriseContext?: RelayEnterpriseContext): Promise<JsonObject> {
    return await this.#callAbsoluteOperationApi(new URL(pathname, this.#localAgentBaseUrl), method, body, enterpriseContext);
  }

  async #callTaskApi(pathname: string, method: 'GET' | 'POST', body?: unknown, enterpriseContext?: RelayEnterpriseContext): Promise<JsonObject> {
    const response = await fetchWithDeadline(new URL(pathname, this.#localAgentBaseUrl).toString(), {
      redirect: 'error', method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${this.#agentToken}`, ...relayRequestHeaders(enterpriseContext) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {})
    }, this.#localRequestTimeoutMs, 'local durable task request');
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

  async #submitResultWithRetry(seq: number, deliveryId: string, result: JsonObject): Promise<void> {
    for (let attempt = 0; attempt < RESULT_SUBMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.#submitResult(seq, deliveryId, result);
        return;
      } catch (error) {
        const lastAttempt = attempt === RESULT_SUBMIT_ATTEMPTS - 1;
        if (lastAttempt || !canRetryResultSubmissionInPlace(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, resultSubmitRetryDelay(attempt)));
      }
    }
  }

  async #submitResult(seq: number, deliveryId: string, result: JsonObject): Promise<void> {
    const token = await this.#sessionCredentials.forRequest();
    let response: Response;
    try {
      response = await fetchWithDeadline(this.#resultUrl, {
        redirect: 'error',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ seq, deliveryId, result })
      }, this.#resultSubmitTimeoutMs, 'relay result submission');
    } catch (error) {
      throw new OperatorError('RELAY_RESULT_SUBMIT_FAILED', `Relay result submission failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        details: { resultChannel: 'transport' }
      });
    }
    if (response.status === 200) return;
    let code = 'RELAY_RESULT_SUBMIT_FAILED';
    try { code = String((await response.json() as any)?.error?.code ?? code); } catch { /* bounded generic failure */ }
    const retryable = response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500;
    throw new OperatorError(code, `Relay result service rejected result with HTTP ${response.status}.`, {
      retryable,
      details: { resultChannel: 'http', httpStatus: response.status }
    });
  }


}

function canRetryResultSubmissionInPlace(error: unknown): boolean {
  if (!(error instanceof OperatorError) || !error.retryable) return false;
  const channel = error.details?.resultChannel;
  if (channel === 'transport') return true;
  const status = Number(error.details?.httpStatus);
  return status === 408 || status === 429 || status >= 500;
}

function resultSubmitRetryDelay(attemptInput: number): number {
  const attempt = Math.max(0, Math.min(10, Math.trunc(attemptInput)));
  return Math.min(RESULT_SUBMIT_RETRY_BASE_MS * 2 ** attempt, RESULT_SUBMIT_RETRY_MAX_MS);
}

function actionRequestTimeoutMs(action: ActionRequest, fallbackMs: number): number {
  const candidate = Number((action.input as Record<string, unknown>).timeoutMs);
  if (Number.isFinite(candidate) && candidate > 0) {
    return Math.min(LOCAL_ACTION_MAX_TIMEOUT_MS, Math.max(30_000, Math.floor(candidate) + 15_000));
  }
  return fallbackMs;
}

function boundedLocalRequestTimeout(value: number): number {
  if (!Number.isFinite(value)) throw new OperatorError('RELAY_LOCAL_TIMEOUT_INVALID', 'Local relay request timeout must be finite.', { retryable: false });
  return Math.max(50, Math.min(LOCAL_ACTION_MAX_TIMEOUT_MS, Math.floor(value)));
}

function boundedResultSubmitTimeout(value: number): number {
  if (!Number.isFinite(value)) throw new OperatorError('RELAY_RESULT_TIMEOUT_INVALID', 'Relay result submission timeout must be finite.', { retryable: false });
  return Math.max(50, Math.min(5 * 60_000, Math.floor(value)));
}

async function fetchWithDeadline(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const bounded = Math.max(50, Math.min(LOCAL_ACTION_MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bounded);
  timer.unref();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OperatorError('RELAY_LOCAL_HTTP_TIMEOUT', `${label} exceeded its bounded ${bounded}ms request deadline.`, {
        retryable: true,
        details: { timeoutMs: bounded }
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function localResourceProfile() {
  const configuredJobs = Number(process.env.OPERATOR_DEVICE_MAX_CONCURRENT_JOBS ?? 1);
  const maxConcurrentJobs = Number.isSafeInteger(configuredJobs) && configuredJobs >= 1 && configuredJobs <= 1024 ? configuredJobs : 1;
  const configuredTags = (process.env.OPERATOR_DEVICE_RESOURCE_TAGS ?? '')
    .split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item));
  return {
    cpuSlots: Math.max(1, Math.min(1024, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length)),
    memoryMb: Math.max(128, Math.min(16 * 1024 * 1024, Math.floor(os.totalmem() / (1024 * 1024)))),
    gpu: process.env.OPERATOR_DEVICE_GPU === '1',
    tags: [...new Set(configuredTags)].sort().slice(0, 64),
    maxConcurrentJobs
  };
}

export { readRelaySessionTokenFile } from './relay-session-credentials.ts';

export function canRetryUncertainRelayDelivery(delivery: RelayDelivery): boolean {
  try {
    if (delivery.kind === 'task') { validateRelayTaskRequest(delivery.payload.task); return true; }
    if (delivery.kind === 'operation') {
      const request = validateRelayOperationRequest(delivery.payload.operation);
      return request.operation !== 'submit' || typeof request.request.requestId === 'string';
    }
    if (delivery.kind === 'knowledge') { validateRelayKnowledgeQuery(delivery.payload.query); return true; }
    if (delivery.kind === 'action') return validateRemoteAction(delivery.payload.action).risk === 'read';
    return false;
  } catch {
    return false;
  }
}

type RelayKnowledgeQuery =
  | { kind: 'procedures'; limit: number }
  | { kind: 'procedure-query'; objectiveKind: string; scopeKey: string; assumptions: unknown[]; requiredCapabilities: string[]; maxResults: number }
  | { kind: 'world-entity'; entityKey: string }
  | { kind: 'world-fact'; entityKey: string; factKey: string }
  | { kind: 'world-trace'; fromKey: string; toKey?: string; targetType?: string; maxDepth?: number; minConfidence?: number }
  | { kind: 'world-list'; scopeKey?: string; type?: string; limit: number }
  | { kind: 'optimizer'; limit: number };

function validateRelayKnowledgeQuery(input: unknown): RelayKnowledgeQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_KNOWLEDGE_INVALID', 'Relay knowledge query must be an object.');
  const raw = input as Record<string, unknown>;
  const kind = String(raw.kind ?? '');
  const text = (value: unknown, label: string, max = 512) => {
    const result = String(value ?? '');
    if (!result || result.length > max || result.includes('\0')) throw new OperatorError('RELAY_KNOWLEDGE_INVALID', `${label} is invalid.`);
    return result;
  };
  const limit = (value: unknown, fallback: number, max: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new OperatorError('RELAY_KNOWLEDGE_INVALID', 'Knowledge limit is invalid.');
    return n;
  };
  if (kind === 'procedures') return { kind, limit: limit(raw.limit, 100, 500) };
  if (kind === 'optimizer') return { kind, limit: limit(raw.limit, 200, 1000) };
  if (kind === 'procedure-query') {
    return {
      kind,
      objectiveKind: text(raw.objectiveKind, 'objectiveKind', 128),
      scopeKey: text(raw.scopeKey, 'scopeKey'),
      assumptions: Array.isArray(raw.assumptions) ? structuredClone(raw.assumptions) : [],
      requiredCapabilities: Array.isArray(raw.requiredCapabilities) ? raw.requiredCapabilities.map((value) => text(value, 'requiredCapability', 256)) : [],
      maxResults: limit(raw.maxResults, 10, 100)
    };
  }
  if (kind === 'world-entity') return { kind, entityKey: text(raw.entityKey, 'entityKey') };
  if (kind === 'world-fact') return { kind, entityKey: text(raw.entityKey, 'entityKey'), factKey: text(raw.factKey, 'factKey', 128) };
  if (kind === 'world-list') return {
    kind,
    ...(raw.scopeKey === undefined ? {} : { scopeKey: text(raw.scopeKey, 'scopeKey') }),
    ...(raw.type === undefined ? {} : { type: text(raw.type, 'type', 128) }),
    limit: limit(raw.limit, 100, 1000)
  };
  if (kind === 'world-trace') {
    const maxDepth = raw.maxDepth === undefined ? undefined : Number(raw.maxDepth);
    const minConfidence = raw.minConfidence === undefined ? undefined : Number(raw.minConfidence);
    if (maxDepth !== undefined && (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 12)) throw new OperatorError('RELAY_KNOWLEDGE_INVALID', 'maxDepth is invalid.');
    if (minConfidence !== undefined && (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)) throw new OperatorError('RELAY_KNOWLEDGE_INVALID', 'minConfidence is invalid.');
    return {
      kind, fromKey: text(raw.fromKey, 'fromKey'),
      ...(raw.toKey === undefined ? {} : { toKey: text(raw.toKey, 'toKey') }),
      ...(raw.targetType === undefined ? {} : { targetType: text(raw.targetType, 'targetType', 128) }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(minConfidence === undefined ? {} : { minConfidence })
    };
  }
  throw new OperatorError('RELAY_KNOWLEDGE_INVALID', 'Knowledge query kind is invalid.');
}

type RelayOperationRequest =
  | { operation: 'submit'; request: Record<string, unknown> }
  | { operation: 'inspect' | 'start' | 'refresh' | 'pause' | 'cancel'; operationId: string }
  | { operation: 'promote'; operationId: string; verificationDigest: string };

function validateRelayOperationRequest(input: unknown): RelayOperationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_OPERATION_INVALID', 'Relay operation payload must be an object.');
  const raw = input as Record<string, unknown>;
  const operation = String(raw.operation ?? '');
  if (operation === 'submit') {
    if (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request)) throw new OperatorError('RELAY_OPERATION_INVALID', 'Relay operation submit requires a request object.');
    const request = structuredClone(raw.request as Record<string, unknown>);
    request.requestId = validTaskUuid(request.requestId, 'operation requestId');
    if (request.device !== undefined) throw new OperatorError('RELAY_OPERATION_INVALID', 'Remote operation request cannot provide device advertisements.');
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_OPERATION_INVALID', 'Relay operation request exceeds bounded size.');
    return { operation: 'submit', request };
  }
  const operationId = validTaskUuid(raw.operationId, 'operationId');
  if (operation === 'promote') {
    const verificationDigest = String(raw.verificationDigest ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(verificationDigest)) throw new OperatorError('RELAY_OPERATION_INVALID', 'Relay operation promotion requires a SHA-256 verification digest.');
    return { operation: 'promote', operationId, verificationDigest };
  }
  if (!['inspect', 'start', 'refresh', 'pause', 'cancel'].includes(operation)) throw new OperatorError('RELAY_OPERATION_INVALID', 'Relay operation control action is invalid.');
  return { operation: operation as 'inspect' | 'start' | 'refresh' | 'pause' | 'cancel', operationId };
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

type RelayEnterpriseContext = {
  principalId: string;
  deviceId: string;
  projectKey?: string;
};

function validateRelayEnterpriseContext(input: unknown, authority: ApprovalAuthorityContext): RelayEnterpriseContext | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('RELAY_ENTERPRISE_CONTEXT_INVALID', 'Relay enterprise context is invalid.');
  }
  const raw = input as Record<string, unknown>;
  const expectedPrincipal = `account:${authority.accountId}`;
  const principalId = String(raw.principalId ?? '').toLowerCase();
  if (principalId !== expectedPrincipal) {
    throw new OperatorError('RELAY_ENTERPRISE_CONTEXT_INVALID', 'Relay enterprise principal does not match the stamped account authority.');
  }
  if (raw.deviceId !== undefined || raw.teamIds !== undefined || raw.environment !== undefined || raw.deviceGroups !== undefined) {
    throw new OperatorError('RELAY_ENTERPRISE_CONTEXT_INVALID', 'Relay enterprise context contains fields that must be derived locally or by trusted identity infrastructure.');
  }
  const projectKey = raw.projectKey === undefined ? undefined : String(raw.projectKey);
  if (projectKey !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(projectKey) || projectKey.includes('\\'))) {
    throw new OperatorError('RELAY_ENTERPRISE_CONTEXT_INVALID', 'Relay enterprise project key is invalid.');
  }
  return { principalId, deviceId: authority.deviceId, ...(projectKey ? { projectKey } : {}) };
}

function relayRequestHeaders(context?: RelayEnterpriseContext): Record<string, string> {
  return {
    'x-operator-relay-request': '1',
    ...(context ? { 'x-operator-enterprise-context': Buffer.from(JSON.stringify(context), 'utf8').toString('base64url') } : {})
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

function oversizedRelayResultFallback(error: unknown, delivery: RelayDelivery): JsonObject {
  if (!(error instanceof OperatorError) || error.code !== 'RELAY_LOCAL_RESULT_TOO_LARGE') throw error;
  const capability = delivery.kind === 'action'
    && delivery.payload.action
    && typeof delivery.payload.action === 'object'
    && !Array.isArray(delivery.payload.action)
    ? String((delivery.payload.action as Record<string, unknown>).capability ?? '')
    : '';
  return {
    ok: false,
    ...(capability ? { capability } : {}),
    provider: 'relay.boundary',
    error: {
      code: 'RELAY_LOCAL_RESULT_TOO_LARGE',
      message: 'Local execution completed, but its result exceeded the relay size limit and was omitted. Do not retry automatically.',
      retryable: false
    },
    evidence: [{
      kind: 'relay_result_boundary',
      status: 'fail',
      message: 'Oversized local result was replaced with a bounded non-retryable relay error.',
      data: { maxResultBytes: MAX_RESULT_BYTES }
    }],
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
