import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountDeviceRegistry, type AccountPrincipal } from '../../../src/core/account-device-registry.ts';
import { actionHash, canonicalJson } from '../../../src/core/action-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { developerAccountIds } from '../../../src/core/developer-relay-surface.ts';
import { DeviceEnrollmentStore } from '../../../src/core/device-enrollment.ts';
import type { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import type { RelayHub } from './relay-hub.ts';
import type { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;

export class RelayControlService {
  #hub: Pick<RelayHub, 'dispatch' | 'recoverIdempotent' | 'bindProject' | 'boundProjectDevice'>;
  #results: Pick<RelayResultStore, 'get' | 'findByIdempotencyKey'>;
  #accounts: Pick<AccountDeviceRegistry, 'resolveOrCreateAccount' | 'erasePrincipal' | 'bindDevice' | 'activeMembershipForDevice' | 'assertCanBindDevice'>;
  #enrollments?: Pick<DeviceEnrollmentStore, 'reserve' | 'peerForClaim' | 'markBound'>;
  #devices?: Pick<DeviceRegistryStore, 'registerVerifiedPeerTracked' | 'unregisterActiveDevice'>;
  #token: string;
  #developerAccounts: Set<string>;
  #server: http.Server | null = null;

  constructor(options: { hub: Pick<RelayHub, 'dispatch' | 'recoverIdempotent' | 'bindProject' | 'boundProjectDevice'>; results: Pick<RelayResultStore, 'get' | 'findByIdempotencyKey'>; accounts: Pick<AccountDeviceRegistry, 'resolveOrCreateAccount' | 'erasePrincipal' | 'bindDevice' | 'activeMembershipForDevice' | 'assertCanBindDevice'>; enrollments?: Pick<DeviceEnrollmentStore, 'reserve' | 'peerForClaim' | 'markBound'>; devices?: Pick<DeviceRegistryStore, 'registerVerifiedPeerTracked' | 'unregisterActiveDevice'>; token: string; developerAccountIds?: string }) {
    if (options.token.length < 32) throw new Error('Relay control token must be at least 32 characters.');
    this.#hub = options.hub;
    this.#results = options.results;
    this.#accounts = options.accounts;
    this.#enrollments = options.enrollments;
    this.#devices = options.devices;
    this.#token = options.token;
    this.#developerAccounts = developerAccountIds(options.developerAccountIds ?? process.env.OPERATOR_DEVELOPER_ACCOUNT_IDS);
  }

  async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
    if (!isLoopback(host)) throw new Error('Relay control service is internal-only and must bind to loopback.');
    if (this.#server) throw new Error('Relay control service is already listening.');
    const server = http.createServer(async (request, response) => {
      const startedAt = performance.now();
      try {
        if (request.method === 'GET' && request.url === '/health') {
          send(response, 200, { ok: true, service: 'operator-relay-control', version: 1 });
          return;
        }
        if (request.method !== 'POST' || !['/v1/execute', '/v1/task', '/v1/account/erase', '/v1/device-enrollment/claim'].includes(request.url ?? '')) {
          send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
          return;
        }
        if (!bearerMatches(request.headers.authorization, this.#token)) {
          send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid relay control bearer token required.' } });
          return;
        }
        if (request.url === '/v1/account/erase') {
          const eraseBody = await readJson(request) as { principal?: unknown };
          if (eraseBody.principal === undefined) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Verified principal is required for account erasure.');
          const erased = await this.#accounts.erasePrincipal(validPrincipal(eraseBody.principal));
          send(response, 200, { ok: true, ...erased });
          return;
        }
        if (request.url === '/v1/device-enrollment/claim') {
          const claimBody = await readJson(request) as { principal?: unknown; accountId?: unknown; userCode?: unknown };
          const principal = claimBody.principal === undefined ? undefined : validPrincipal(claimBody.principal);
          const explicitAccountId = claimBody.accountId === undefined ? undefined : validUuid(String(claimBody.accountId), 'accountId');
          if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required for device enrollment claim.');
          const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
          if (!this.#enrollments || !this.#devices) throw new OperatorError('DEVICE_ENROLLMENT_UNAVAILABLE', 'Device enrollment authority is not configured.');
          const userCode = boundedText(String(claimBody.userCode ?? ''), 32, 'device enrollment code');
          const reserved = await this.#enrollments.reserve(userCode, accountId);
          const peer = await this.#enrollments.peerForClaim(reserved.enrollmentId, accountId);
          await this.#accounts.assertCanBindDevice(accountId, reserved.deviceId);
          const registration = await this.#devices.registerVerifiedPeerTracked(peer);
          let membership;
          try {
            membership = await this.#accounts.bindDevice(accountId, reserved.deviceId);
          } catch (error) {
            if (registration.created) {
              try { await this.#devices.unregisterActiveDevice(peer.deviceId, peer.fingerprint); } catch { /* preserve the original binding failure */ }
            }
            throw error;
          }
          const claimed = await this.#enrollments.markBound(reserved.enrollmentId, accountId, membership.authorityGeneration);
          send(response, 200, { ok: true, enrollment: { status: claimed.status } });
          return;
        }
        if (request.url === '/v1/task') {
          await this.#handleTaskRequest(request, response);
          return;
        }
        const body = await readJson(request) as {
          accountId?: unknown;
          principal?: unknown;
          deviceId?: unknown;
          projectKey?: unknown;
          action?: unknown;
          publicBoundary?: unknown;
          developerBoundary?: unknown;
          waitMs?: unknown;
        };
        const principal = body.principal === undefined ? undefined : validPrincipal(body.principal);
        const explicitAccountId = body.accountId === undefined ? undefined : validUuid(String(body.accountId), 'accountId');
        if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required.');
        const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
        const developerBoundary = body.developerBoundary === true;
        if (developerBoundary && !this.#developerAccounts.has(accountId)) {
          throw new OperatorError('DEVELOPER_ACCOUNT_REQUIRED', 'This relay request requires an explicitly entitled Mecord developer account.');
        }
        const deviceId = body.deviceId === undefined ? undefined : validUuid(String(body.deviceId), 'deviceId');
        const projectKey = body.projectKey === undefined ? undefined : validProjectKey(String(body.projectKey));
        const action = validAction(body.action);
        const publicBoundary = body.publicBoundary === true;
        const waitMs = body.waitMs === undefined ? DEFAULT_WAIT_MS : boundedWait(body.waitMs);
        // Stateless MCP clients commonly reuse the same JSON-RPC request ID for
        // separate tool calls. A durable receipt keyed only by that ID would
        // therefore turn later reads into permanent snapshots (and can replay
        // an old failure after the device has been upgraded). Reads are safe to
        // execute again, so give each control request a fresh relay receipt.
        // Public file.create is protected by exclusive-create semantics and
        // file.replace by its required content-SHA precondition plus one-shot
        // approval. They can also be safely re-evaluated: doing so makes a
        // genuinely new identical create observe TARGET_EXISTS instead of an
        // old success. Other mutations retain the deterministic receipt so a
        // transport retry cannot duplicate an unguarded side effect.
        const idempotencyKey = requiresFreshReceipt(action)
          ? freshExecutionReceiptKey(accountId, action, publicBoundary)
          : actionIdempotencyKey(accountId, action, publicBoundary);

        const completed = await this.#results.findByIdempotencyKey(idempotencyKey);
        if (completed) {
          await this.#assertReplayAuthority(accountId, completed.deviceId, completed.result.replayAuthority);
          const result = completed.result.result as unknown as ActionResult;
          if (!isActionResult(result, action.capability)) {
            return send(response, 502, relayFailure(action.capability, startedAt, 'RELAY_RESULT_INVALID', 'Stored replay result is malformed.', completed.deviceId, completed.result.seq));
          }
          send(response, 200, result);
          return;
        }

        const recovered = await this.#hub.recoverIdempotent(idempotencyKey);
        let routedDeviceId: string;
        let delivery: { id: string; seq: number };
        if (recovered) {
          if (recovered.delivery.status === 'expired') {
            return send(response, 409, relayFailure(action.capability, startedAt, 'RELAY_EXECUTION_EXPIRED_UNCERTAIN', 'The original invocation expired before a durable result was recorded; refusing to execute it again.', recovered.deviceId, recovered.delivery.seq));
          }
          routedDeviceId = recovered.deviceId;
          delivery = recovered.delivery;
        } else {
          const dispatched = await this.#hub.dispatch({
            accountId,
            explicitDeviceId: deviceId,
            projectKey,
            requiredCapabilities: [action.capability],
            kind: 'action',
            payload: { action, ...(publicBoundary ? { publicBoundary: true } : {}) },
            idempotencyKey
          });
          routedDeviceId = dispatched.route.deviceId;
          delivery = dispatched.delivery;
        }
        const deadline = Date.now() + waitMs;
        while (Date.now() <= deadline) {
          if (request.aborted || response.destroyed) return;
          const stored = await this.#results.get(routedDeviceId, delivery.seq);
          if (stored && stored.deliveryId === delivery.id) {
            await this.#assertReplayAuthority(accountId, routedDeviceId, stored.replayAuthority);
            const result = stored.result as unknown as ActionResult;
            if (!isActionResult(result, action.capability)) {
              return send(response, 502, relayFailure(action.capability, startedAt, 'RELAY_RESULT_INVALID', 'Device returned a malformed ActionResult.', routedDeviceId, delivery.seq));
            }
            send(response, 200, result);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        send(response, 504, relayFailure(
          action.capability,
          startedAt,
          'RELAY_RESULT_PENDING',
          'The routed action has no durable result yet. Do not blindly repeat the action; reconcile the delivery first.',
          routedDeviceId,
          delivery.seq
        ));
      } catch (error) {
        const op = error instanceof OperatorError ? error : new OperatorError('RELAY_CONTROL_FAILED', error instanceof Error ? error.message : String(error));
        const status = op.code === 'REQUEST_TOO_LARGE' ? 413 : op.code === 'UNAUTHORIZED' ? 401 : 409;
        send(response, status, relayFailure('relay.execute', startedAt, op.code, op.message, undefined, undefined, op.retryable));
      }
    });
    applyBoundedHttpServerPolicy(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    this.#server = server;
    const address = server.address() as AddressInfo;
    return { host, port: address.port };
  }

  async #handleTaskRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await readJson(request) as {
      accountId?: unknown; principal?: unknown; deviceId?: unknown; projectKey?: unknown; task?: unknown; developerBoundary?: unknown; waitMs?: unknown;
    };
    const principal = body.principal === undefined ? undefined : validPrincipal(body.principal);
    const explicitAccountId = body.accountId === undefined ? undefined : validUuid(String(body.accountId), 'accountId');
    if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required.');
    const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
    const developerBoundary = body.developerBoundary === true;
    if (developerBoundary && !this.#developerAccounts.has(accountId)) {
      throw new OperatorError('DEVELOPER_ACCOUNT_REQUIRED', 'This task request requires an explicitly entitled Mecord developer account.');
    }
    const requestedDeviceId = body.deviceId === undefined ? undefined : validUuid(String(body.deviceId), 'deviceId');
    const requestedProjectKey = body.projectKey === undefined ? undefined : validProjectKey(String(body.projectKey));
    const waitMs = body.waitMs === undefined ? DEFAULT_WAIT_MS : boundedWait(body.waitMs);
    const task = validTaskRelayRequest(body.task);
    const bindingKey = taskBindingKey(task.taskId);
    let boundDeviceId: string | undefined;
    try { boundDeviceId = await this.#hub.boundProjectDevice(accountId, bindingKey); }
    catch (error) {
      if (!(error instanceof OperatorError) || error.code !== 'ROUTE_PROJECT_UNBOUND' || task.operation !== 'submit') throw error;
    }
    if (requestedDeviceId && boundDeviceId && requestedDeviceId !== boundDeviceId) {
      throw new OperatorError('ROUTE_PROJECT_DEVICE_CONFLICT', 'Explicit device conflicts with the durable task-to-device binding.');
    }
    if (task.operation !== 'submit' && !boundDeviceId) {
      throw new OperatorError('ROUTE_PROJECT_UNBOUND', 'Durable task control requires its persisted task-to-device binding.');
    }

    const dispatched = await this.#hub.dispatch({
      accountId,
      explicitDeviceId: boundDeviceId ?? requestedDeviceId,
      projectKey: boundDeviceId ? bindingKey : requestedProjectKey,
      requiredCapabilities: task.requiredCapabilities,
      kind: 'task',
      payload: { task: task.payload },
      idempotencyKey: freshTaskReceiptKey(accountId, task.payload)
    });
    const routedDeviceId = dispatched.route.deviceId;
    if (task.operation === 'submit') await this.#hub.bindProject(accountId, bindingKey, routedDeviceId);

    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
      if (request.aborted || response.destroyed) return;
      const stored = await this.#results.get(routedDeviceId, dispatched.delivery.seq);
      if (stored && stored.deliveryId === dispatched.delivery.id) {
        await this.#assertReplayAuthority(accountId, routedDeviceId, stored.replayAuthority);
        const result = stored.result as unknown;
        if (!isTaskTransportResult(result)) {
          send(response, 502, { ok: false, error: { code: 'RELAY_TASK_RESULT_INVALID', message: 'Device returned a malformed durable task result.' } });
          return;
        }
        send(response, 200, result);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    send(response, 504, { ok: false, error: { code: 'RELAY_TASK_RESULT_PENDING', message: 'The routed durable task operation has no result yet; retry with the same task UUID.' } });
  }

  async #assertReplayAuthority(accountId: string, deviceId: string, authority: { accountId: string; deviceId: string; generation: number } | undefined): Promise<void> {
    if (!authority || authority.accountId !== accountId || authority.deviceId !== deviceId) {
      throw new OperatorError('RELAY_RESULT_AUTHORITY_REVOKED', 'Stored relay result is not bound to the current account/device authority.');
    }
    const active = await this.#accounts.activeMembershipForDevice(deviceId);
    if (!active || active.accountId !== authority.accountId || active.authorityGeneration !== authority.generation) {
      throw new OperatorError('RELAY_RESULT_AUTHORITY_REVOKED', 'Stored relay result account authority is no longer active.');
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function relayFailure(capability: string, startedAt: number, code: string, message: string, deviceId?: string, seq?: number, retryable = false): ActionResult {
  return {
    ok: false,
    capability,
    provider: 'relay.control',
    evidence: [{
      kind: 'relay',
      status: 'fail',
      message,
      data: { code, ...(deviceId ? { deviceId } : {}), ...(seq ? { deliverySeq: seq } : {}) },
      timestamp: new Date().toISOString()
    }],
    error: { code, message, retryable },
    durationMs: Math.round(performance.now() - startedAt)
  };
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new OperatorError('REQUEST_TOO_LARGE', 'Relay control request exceeds the maximum body size.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control request body is required.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control request must contain valid JSON.'); }
}

type ValidatedTaskRelayRequest = {
  operation: 'submit' | 'inspect' | 'run' | 'pause' | 'resume' | 'cancel';
  taskId: string;
  payload: Record<string, unknown>;
  requiredCapabilities: string[];
};

function validTaskRelayRequest(input: unknown): ValidatedTaskRelayRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task request is required.');
  const raw = input as Record<string, unknown>;
  const operation = String(raw.operation ?? '');
  if (operation === 'submit') {
    if (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task submit request is required.');
    const request = structuredClone(raw.request as Record<string, unknown>);
    const taskId = validUuid(String(request.requestId ?? ''), 'task requestId');
    if (!request.goal || typeof request.goal !== 'object' || Array.isArray(request.goal)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task goal is required.');
    const encoded = canonicalJson(request);
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task request exceeds the bounded size.');
    request.requestId = taskId;
    return {
      operation: 'submit', taskId,
      payload: { operation: 'submit', request },
      requiredCapabilities: taskRequiredCapabilities(request.goal)
    };
  }
  if (!['inspect', 'run', 'pause', 'resume', 'cancel'].includes(operation)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task operation is invalid.');
  if (raw.approvedActionId !== undefined) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Remote task control cannot carry local approval authority.');
  const taskId = validUuid(String(raw.taskId ?? ''), 'taskId');
  return {
    operation: operation as ValidatedTaskRelayRequest['operation'],
    taskId,
    payload: { operation, taskId },
    requiredCapabilities: []
  };
}

function taskRequiredCapabilities(goalInput: unknown, allowWorkflow = true): string[] {
  if (!goalInput || typeof goalInput !== 'object' || Array.isArray(goalInput)) {
    throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task goal is invalid.');
  }
  const goal = goalInput as Record<string, unknown>;
  switch (String(goal.kind ?? '')) {
    case 'controlled-file-change': return ['file.list', 'file.create', 'file.read', 'git.status'];
    case 'trusted-project-command':
    case 'project-quality-gate':
      return ['project.inspect', 'project.command.inspect', 'project.command.run'];
    case 'browser-navigation': return ['browser.inspect', 'browser.navigate'];
    case 'app-operation': return ['app.inspect', 'app.operate'];
    case 'docker-lifecycle': return ['docker.inspect', 'docker.manage'];
    case 'postgres-select': return ['postgres.inspect', 'postgres.select'];
    case 'semantic-workflow': {
      if (!allowWorkflow || !Array.isArray(goal.steps) || goal.steps.length < 1 || goal.steps.length > 20) {
        throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'semantic workflow must contain 1-20 non-nested typed goals.');
      }
      return [...new Set(goal.steps.flatMap((step) => taskRequiredCapabilities(step, false)))].sort();
    }
    default: throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'task goal kind is unsupported.');
  }
}

function taskBindingKey(taskId: string): string { return `task:${validUuid(taskId, 'taskId')}`; }

function freshTaskReceiptKey(accountId: string, payload: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update('operator-relay-task-receipt-v1:')
    .update(accountId)
    .update(':')
    .update(canonicalJson(payload))
    .update(':')
    .update(crypto.randomBytes(32))
    .digest('hex');
}

function isTaskTransportResult(input: unknown): input is { ok: boolean; task?: Record<string, unknown>; error?: { code?: string; message?: string } } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const raw = input as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean') return false;
  if (raw.ok) return Boolean(raw.task && typeof raw.task === 'object' && !Array.isArray(raw.task));
  if (!raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)) return false;
  const error = raw.error as Record<string, unknown>;
  return typeof error.code === 'string' && typeof error.message === 'string';
}

function validAction(input: unknown): ActionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'action is required.');
  const raw = input as Record<string, unknown>;
  const id = validName(String(raw.id ?? ''), 'action id');
  const capability = validName(String(raw.capability ?? ''), 'capability');
  const risk = String(raw.risk ?? '');
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(risk)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action input must be an object.');
  const inputText = JSON.stringify(raw.input);
  if (Buffer.byteLength(inputText, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Action input exceeds the bounded size.');
  if (!raw.provenance || typeof raw.provenance !== 'object' || Array.isArray(raw.provenance) || (raw.provenance as any).kind !== 'chatgpt') {
    throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Relay control accepts only ChatGPT-provenance actions.');
  }
  const target = raw.target === undefined ? undefined : boundedText(String(raw.target), 2048, 'target');
  const taskId = raw.taskId === undefined ? undefined : validName(String(raw.taskId), 'taskId');
  return {
    id,
    capability,
    risk: risk as ActionRequest['risk'],
    input: structuredClone(raw.input as Record<string, unknown>),
    provenance: { kind: 'chatgpt' },
    target,
    taskId
  };
}

function isActionResult(input: ActionResult, capability: string): boolean {
  return Boolean(input && typeof input === 'object' && typeof input.ok === 'boolean' && input.capability === capability && typeof input.provider === 'string' && Array.isArray(input.evidence) && Number.isFinite(input.durationMs));
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function validSeq(input: unknown): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'delivery sequence is invalid.');
  return value;
}

function actionIdempotencyKey(accountId: string, action: ActionRequest, publicBoundary: boolean): string {
  const digest = crypto.createHash('sha256').update('operator-relay-action-receipt-v1:').update(accountId).update(':').update(action.id).update(':').update(action.taskId ?? '').update(':').update(actionHash(action)).update(':').update(publicBoundary ? '1' : '0');
  return digest.digest('hex');
}

function requiresFreshReceipt(action: ActionRequest): boolean {
  if (action.risk === 'read') return true;
  if (action.capability === 'file.create') return true;
  return action.capability === 'file.replace'
    && typeof action.input.expectedSha256 === 'string'
    && /^[0-9a-f]{64}$/i.test(action.input.expectedSha256);
}

function freshExecutionReceiptKey(accountId: string, action: ActionRequest, publicBoundary: boolean): string {
  return crypto.createHash('sha256')
    .update('operator-relay-fresh-execution-receipt-v1:')
    .update(accountId)
    .update(':')
    .update(actionHash(action))
    .update(':')
    .update(publicBoundary ? '1' : '0')
    .update(':')
    .update(crypto.randomBytes(32))
    .digest('hex');
}

function boundedWait(input: unknown): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1_000 || value > MAX_WAIT_MS) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `waitMs must be between 1000 and ${MAX_WAIT_MS}.`);
  return value;
}

function validPrincipal(input: unknown): AccountPrincipal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'principal must be an object.');
  const raw = input as Record<string, unknown>;
  const issuer = boundedText(String(raw.issuer ?? ''), 1024, 'principal issuer').trim();
  const subject = boundedText(String(raw.subject ?? ''), 1024, 'principal subject').trim();
  if (!issuer || !subject || /[\0\r\n]/.test(issuer) || /[\0\r\n]/.test(subject)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'principal is invalid.');
  return { issuer, subject };
}

function validUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} must be a UUID.`);
  return value.toLowerCase();
}

function validProjectKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'projectKey is invalid.');
  return value;
}

function validName(value: string, label: string): string {
  if (!value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function boundedText(value: string, max: number, label: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > max) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function isLoopback(input: string): boolean {
  const host = input.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function send(response: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  response.end(body);
}
