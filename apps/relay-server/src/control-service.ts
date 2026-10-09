import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccountDeviceRegistry, type AccountPrincipal } from '../../../src/core/account-device-registry.ts';
import { actionHash, canonicalJson } from '../../../src/core/action-identity.ts';
import { capabilityRiskRule } from '../../../src/core/capability-policy.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { developerAccountIds } from '../../../src/core/developer-relay-surface.ts';
import { DeviceEnrollmentStore } from '../../../src/core/device-enrollment.ts';
import type { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import { applyBoundedHttpServerPolicy } from '../../../src/core/network-authority.ts';
import type { RelayDispatchRequest, RelayHub } from './relay-hub.ts';
import type { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';
import type { DeviceReservation } from '../../../src/core/device-pool.ts';
import type { RelayReservationReconciliation, RelayReservationReconciliationStore } from '../../../src/core/relay-reservation-reconciliation.ts';

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;
const TRANSPORT_RECOVERY_WINDOW_MS = 5_000;
const TRANSPORT_RECOVERY_MAX_DELAY_MS = 750;

export interface RelayControlDiagnostic {
  service: 'operator-relay-control';
  status: 'request-failed' | 'reservation-reconciliation-required' | 'reservation-reconciled';
  code: string;
  action?: 'renew' | 'release';
}

export class RelayControlService {
  #hub: Pick<RelayHub, 'dispatch' | 'recoverIdempotent' | 'bindProject' | 'boundProjectDevice' | 'setDefaultDevice' | 'reserveDevice' | 'heartbeatDeviceReservation' | 'releaseDeviceReservation' | 'listDeviceReservations'>;
  #results: Pick<RelayResultStore, 'get' | 'findByIdempotencyKey'>;
  #accounts: Pick<AccountDeviceRegistry, 'resolveOrCreateAccount' | 'erasePrincipal' | 'bindDevice' | 'activeMembershipForDevice' | 'assertCanBindDevice'>;
  #enrollments?: Pick<DeviceEnrollmentStore, 'reserve' | 'peerForClaim' | 'markBound'>;
  #devices?: Pick<DeviceRegistryStore, 'registerVerifiedPeerTracked' | 'unregisterActiveDevice'>;
  #token: string;
  #developerAccounts: Set<string>;
  #onDiagnostic?: (event: RelayControlDiagnostic) => void;
  #reservationReconciliations?: Pick<RelayReservationReconciliationStore, 'record' | 'resolve' | 'pending'>;
  #server: http.Server | null = null;

  constructor(options: { hub: Pick<RelayHub, 'dispatch' | 'recoverIdempotent' | 'bindProject' | 'boundProjectDevice' | 'setDefaultDevice' | 'reserveDevice' | 'heartbeatDeviceReservation' | 'releaseDeviceReservation' | 'listDeviceReservations'>; results: Pick<RelayResultStore, 'get' | 'findByIdempotencyKey'>; accounts: Pick<AccountDeviceRegistry, 'resolveOrCreateAccount' | 'erasePrincipal' | 'bindDevice' | 'activeMembershipForDevice' | 'assertCanBindDevice'>; enrollments?: Pick<DeviceEnrollmentStore, 'reserve' | 'peerForClaim' | 'markBound'>; devices?: Pick<DeviceRegistryStore, 'registerVerifiedPeerTracked' | 'unregisterActiveDevice'>; reservationReconciliations?: Pick<RelayReservationReconciliationStore, 'record' | 'resolve' | 'pending'>; token: string; developerAccountIds?: string; onDiagnostic?: (event: RelayControlDiagnostic) => void }) {
    if (options.token.length < 32) throw new Error('Relay control token must be at least 32 characters.');
    this.#hub = options.hub;
    this.#results = options.results;
    this.#accounts = options.accounts;
    this.#enrollments = options.enrollments;
    this.#devices = options.devices;
    this.#token = options.token;
    this.#developerAccounts = developerAccountIds(options.developerAccountIds ?? process.env.OPERATOR_DEVELOPER_ACCOUNT_IDS);
    this.#onDiagnostic = options.onDiagnostic;
    this.#reservationReconciliations = options.reservationReconciliations;
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
        if (request.method !== 'POST' || !['/v1/execute', '/v1/task', '/v1/operation', '/v1/knowledge', '/v1/account/erase', '/v1/account/default-device', '/v1/device-enrollment/claim'].includes(request.url ?? '')) {
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
        if (request.url === '/v1/account/default-device') {
          const defaultBody = await readJson(request) as { principal?: unknown; accountId?: unknown; deviceId?: unknown };
          const principal = defaultBody.principal === undefined ? undefined : validPrincipal(defaultBody.principal);
          const explicitAccountId = defaultBody.accountId === undefined ? undefined : validUuid(String(defaultBody.accountId), 'accountId');
          if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required.');
          const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
          const deviceId = validUuid(String(defaultBody.deviceId ?? ''), 'deviceId');
          await this.#hub.setDefaultDevice(accountId, deviceId);
          send(response, 200, { ok: true, defaultDevice: { status: 'selected' } });
          return;
        }
        if (request.url === '/v1/device-enrollment/claim') {
          const claimBody = await readJson(request) as { principal?: unknown; accountId?: unknown; userCode?: unknown; makeDefault?: unknown };
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
          if (claimBody.makeDefault === true) await this.#hub.setDefaultDevice(accountId, reserved.deviceId);
          const claimed = await this.#enrollments.markBound(reserved.enrollmentId, accountId, membership.authorityGeneration);
          send(response, 200, { ok: true, enrollment: { status: claimed.status } });
          return;
        }
        if (request.url === '/v1/task') {
          await this.#handleTaskRequest(request, response);
          return;
        }
        if (request.url === '/v1/operation') {
          await this.#handleOperationRequest(request, response);
          return;
        }
        if (request.url === '/v1/knowledge') {
          await this.#handleKnowledgeRequest(request, response);
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
          const dispatched = await this.#dispatchWithRecovery({
            accountId,
            explicitDeviceId: deviceId,
            projectKey,
            requiredCapabilities: [action.capability],
            kind: 'action',
            payload: { action, enterpriseContext: relayEnterpriseContext(accountId, projectKey), ...(publicBoundary ? { publicBoundary: true } : {}) },
            idempotencyKey
          }, { allowUnpinnedRouteRetry: capabilityRiskRule(action.capability) === 'read' });
          routedDeviceId = dispatched.deviceId;
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
        try {
          this.#onDiagnostic?.({ service: 'operator-relay-control', status: 'request-failed', code: safeDiagnosticCode(op.code) });
        } catch { /* diagnostics must never affect the control response */ }
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

  async #dispatchWithRecovery(
    request: RelayDispatchRequest,
    options: { allowUnpinnedRouteRetry?: boolean; recoveryWindowMs?: number } = {}
  ) {
    const recoveryWindowMs = Math.max(0, Math.min(options.recoveryWindowMs ?? TRANSPORT_RECOVERY_WINDOW_MS, TRANSPORT_RECOVERY_WINDOW_MS));
    const deadline = Date.now() + recoveryWindowMs;
    let attempt = 0;
    let pinnedDeviceId = request.explicitDeviceId;

    while (true) {
      try {
        const dispatched = await this.#hub.dispatch({
          ...request,
          ...(pinnedDeviceId ? { explicitDeviceId: pinnedDeviceId } : {})
        });
        return { deviceId: dispatched.route.deviceId, delivery: dispatched.delivery, recovered: attempt > 0 };
      } catch (error) {
        if (!(error instanceof OperatorError) || !isRecoverableRelayDispatchError(error)) throw error;
        if (!request.idempotencyKey) throw error;

        const existing = await this.#hub.recoverIdempotent(request.idempotencyKey);
        if (existing) {
          if (existing.delivery.status === 'expired') {
            throw new OperatorError(
              'RELAY_EXECUTION_EXPIRED_UNCERTAIN',
              'The invocation expired after dispatch began and cannot be safely replayed.',
              { retryable: false, details: { deviceId: existing.deviceId, sideEffectState: 'uncertain', safeToRetry: false } }
            );
          }
          return { deviceId: existing.deviceId, delivery: existing.delivery, recovered: true };
        }

        const errorDeviceId = typeof error.details?.deviceId === 'string' ? error.details.deviceId : undefined;
        if (errorDeviceId) pinnedDeviceId = validUuid(errorDeviceId, 'recovery deviceId');
        const routeIsPinned = Boolean(pinnedDeviceId);
        if (!routeIsPinned && options.allowUnpinnedRouteRetry !== true) throw error;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw error;
        const delayMs = Math.min(remainingMs, relayRecoveryDelayMs(attempt++));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
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

    const dispatched = await this.#dispatchWithRecovery({
      accountId,
      explicitDeviceId: boundDeviceId ?? requestedDeviceId,
      projectKey: boundDeviceId ? bindingKey : requestedProjectKey,
      requiredCapabilities: task.requiredCapabilities,
      kind: 'task',
      payload: { task: task.payload, enterpriseContext: relayEnterpriseContext(accountId, requestedProjectKey) },
      idempotencyKey: freshTaskReceiptKey(accountId, task.payload)
    });
    const routedDeviceId = dispatched.deviceId;
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

  async #handleKnowledgeRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await readJson(request) as {
      accountId?: unknown; principal?: unknown; deviceId?: unknown; projectKey?: unknown; query?: unknown; waitMs?: unknown;
    };
    const principal = body.principal === undefined ? undefined : validPrincipal(body.principal);
    const explicitAccountId = body.accountId === undefined ? undefined : validUuid(String(body.accountId), 'accountId');
    if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required.');
    const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
    if (!this.#developerAccounts.has(accountId)) throw new OperatorError('DEVELOPER_ACCOUNT_REQUIRED', 'Knowledge inspection requires an explicitly entitled Mecord developer account.');
    const deviceId = body.deviceId === undefined ? undefined : validUuid(String(body.deviceId), 'deviceId');
    const projectKey = body.projectKey === undefined ? undefined : validProjectKey(String(body.projectKey));
    const query = validKnowledgeRelayQuery(body.query);
    const waitMs = body.waitMs === undefined ? DEFAULT_WAIT_MS : boundedWait(body.waitMs);
    const dispatched = await this.#dispatchWithRecovery({
      accountId,
      explicitDeviceId: deviceId,
      projectKey,
      requiredCapabilities: [],
      kind: 'knowledge',
      payload: { query, enterpriseContext: relayEnterpriseContext(accountId, projectKey) },
      idempotencyKey: freshKnowledgeReceiptKey(accountId, query)
    }, { allowUnpinnedRouteRetry: true });
    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
      if (request.aborted || response.destroyed) return;
      const stored = await this.#results.get(dispatched.deviceId, dispatched.delivery.seq);
      if (stored && stored.deliveryId === dispatched.delivery.id) {
        await this.#assertReplayAuthority(accountId, dispatched.deviceId, stored.replayAuthority);
        const result = stored.result as unknown;
        if (!isKnowledgeTransportResult(result)) {
          send(response, 502, { ok: false, error: { code: 'RELAY_KNOWLEDGE_RESULT_INVALID', message: 'Device returned a malformed knowledge result.' } });
          return;
        }
        send(response, 200, result);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    send(response, 504, { ok: false, error: { code: 'RELAY_KNOWLEDGE_RESULT_PENDING', message: 'The routed knowledge read has no durable result yet; retry is safe.' } });
  }

  async #handleOperationRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const body = await readJson(request) as {
      accountId?: unknown; principal?: unknown; deviceId?: unknown; projectKey?: unknown;
      operation?: unknown; resourceRequirements?: unknown; waitMs?: unknown;
    };
    const principal = body.principal === undefined ? undefined : validPrincipal(body.principal);
    const explicitAccountId = body.accountId === undefined ? undefined : validUuid(String(body.accountId), 'accountId');
    if (Boolean(principal) === Boolean(explicitAccountId)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Exactly one accountId or verified principal is required.');
    const accountId = principal ? (await this.#accounts.resolveOrCreateAccount(principal)).accountId : explicitAccountId!;
    if (!this.#developerAccounts.has(accountId)) throw new OperatorError('DEVELOPER_ACCOUNT_REQUIRED', 'Digital operations require an explicitly entitled Mecord developer account.');
    const requestedDeviceId = body.deviceId === undefined ? undefined : validUuid(String(body.deviceId), 'deviceId');
    const projectKey = body.projectKey === undefined ? undefined : validProjectKey(String(body.projectKey));
    const waitMs = body.waitMs === undefined ? DEFAULT_WAIT_MS : boundedWait(body.waitMs);
    const operation = validOperationRelayRequest(body.operation);
    const bindingKey = operationBindingKey(operation.operationId);
    await this.#recoverReservationReconciliations();
    const unresolved = (await this.#reservationReconciliations?.pending() ?? [])
      .find((item) => item.accountId === accountId && item.workloadKey === bindingKey);
    if (unresolved) {
      throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_REQUIRED', `Reservation ${unresolved.action} bookkeeping remains unresolved; refusing to route more operation work.`);
    }
    const submitLeaseMs = operation.operation === 'submit' && operation.request
      ? operationReservationLeaseMs(operation.request)
      : undefined;

    let routedDeviceId: string;
    let delivery: { id: string; seq: number };
    let reservation: DeviceReservation | undefined;
    let reservationCreated = false;

    const activeReservationFor = async (deviceId?: string): Promise<DeviceReservation | undefined> => {
      const reservations = await this.#hub.listDeviceReservations(accountId, { activeOnly: true, ...(deviceId ? { deviceId } : {}), limit: 5000 });
      return reservations.find((item) => item.workloadKey === bindingKey);
    };
    const latestReservationFor = async (deviceId: string): Promise<DeviceReservation | undefined> => {
      const reservations = await this.#hub.listDeviceReservations(accountId, { deviceId, limit: 5000 });
      return reservations.find((item) => item.workloadKey === bindingKey);
    };
    const renewReservation = async (current: DeviceReservation, renewMs: number): Promise<DeviceReservation> => {
      try {
        const renewed = await this.#hub.heartbeatDeviceReservation(accountId, current.id, current.sessionId, renewMs);
        assertExactRenewalReceipt(current, renewed);
        return renewed;
      } catch (error) {
        if (!(error instanceof OperatorError) || error.code !== 'DEVICE_POOL_SESSION_CHANGED') {
          await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation: current, action: 'renew', leaseMs: renewMs, error });
          throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_REQUIRED', 'Active reservation renewal failed; operation capacity ownership requires reconciliation.');
        }
        try { await this.#hub.releaseDeviceReservation(accountId, current.id); }
        catch (releaseError) {
          await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation: current, action: 'release', error: releaseError });
          throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_REQUIRED', 'Stale reservation could not be released; replacement capacity will not be allocated until reconciliation succeeds.');
        }
        let replacement: DeviceReservation;
        try {
          replacement = await this.#hub.reserveDevice(accountId, {
            workloadKey: bindingKey,
            ...(current.projectKey ? { projectKey: current.projectKey } : {}),
            explicitDeviceId: current.deviceId,
            requiredCapabilities: current.requiredCapabilities,
            requiredTags: current.requiredTags,
            minMemoryMb: current.minMemoryMb,
            requireGpu: current.requireGpu,
            slots: current.slots,
            leaseMs: renewMs
          });
        } catch (reserveError) {
          await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation: current, action: 'renew', leaseMs: renewMs, error: reserveError });
          throw new OperatorError('RELAY_RESERVATION_RECONCILIATION_REQUIRED', 'Replacement reservation could not be established after session change.');
        }
        reservationCreated = true;
        return replacement;
      }
    };

    if (operation.operation === 'submit') {
      let boundDeviceId: string | undefined;
      try { boundDeviceId = await this.#hub.boundProjectDevice(accountId, bindingKey); }
      catch (error) {
        if (!(error instanceof OperatorError) || error.code !== 'ROUTE_PROJECT_UNBOUND') throw error;
      }
      const requirements = validOperationResourceRequirements(body.resourceRequirements);
      if (!operation.request) {
        throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Validated operation submit request is missing its request payload.');
      }
      const requiredCapabilities = operationRequiredCapabilities(operation.request);
      reservation = await activeReservationFor(boundDeviceId ?? requestedDeviceId);
      if (reservation) {
        if (requestedDeviceId && reservation.deviceId !== requestedDeviceId) {
          throw new OperatorError('ROUTE_PROJECT_DEVICE_CONFLICT', 'Existing operation reservation conflicts with the requested device.');
        }
        if (!operationReservationMatches(reservation, requiredCapabilities, requirements)) {
          throw new OperatorError('DEVICE_POOL_RESERVATION_CONFLICT', 'Existing operation reservation is bound to different resource requirements.');
        }
        reservation = await renewReservation(reservation, submitLeaseMs ?? reservationLeaseDuration(reservation));
      } else {
        reservation = await this.#hub.reserveDevice(accountId, {
          workloadKey: bindingKey,
          ...(projectKey ? { projectKey } : {}),
          ...(requestedDeviceId ?? boundDeviceId ? { explicitDeviceId: requestedDeviceId ?? boundDeviceId } : {}),
          requiredCapabilities,
          requiredTags: requirements.requiredTags,
          minMemoryMb: requirements.minMemoryMb,
          requireGpu: requirements.requireGpu,
          slots: requirements.slots,
          leaseMs: submitLeaseMs!
        });
        reservationCreated = true;
      }
      routedDeviceId = reservation.deviceId;
      try {
        await this.#hub.bindProject(accountId, bindingKey, routedDeviceId);
      } catch (error) {
        if (reservationCreated) {
          try { await this.#hub.releaseDeviceReservation(accountId, reservation.id); }
          catch (releaseError) {
            await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation, action: 'release', error: releaseError });
          }
        }
        throw error;
      }
      try {
        const dispatched = await this.#dispatchWithRecovery({
          accountId,
          explicitDeviceId: routedDeviceId,
          requiredCapabilities,
          kind: 'operation',
          payload: { operation: operation.payload, enterpriseContext: relayEnterpriseContext(accountId, projectKey) },
          idempotencyKey: operationIdempotencyKey(accountId, operation.payload)
        });
        delivery = dispatched.delivery;
      } catch (error) {
        if (reservationCreated && reservation) {
          try { await this.#hub.releaseDeviceReservation(accountId, reservation.id); }
          catch (releaseError) {
            await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation, action: 'release', error: releaseError });
          }
        }
        throw error;
      }
    } else {
      const boundDeviceId = await this.#hub.boundProjectDevice(accountId, bindingKey);
      if (requestedDeviceId && requestedDeviceId !== boundDeviceId) throw new OperatorError('ROUTE_PROJECT_DEVICE_CONFLICT', 'Explicit device conflicts with the durable operation-to-device binding.');
      routedDeviceId = boundDeviceId;
      reservation = await activeReservationFor(boundDeviceId);
      if (reservation) {
        reservation = await renewReservation(reservation, submitLeaseMs ?? reservationLeaseDuration(reservation));
      } else {
        const previous = await latestReservationFor(boundDeviceId);
        if (previous && previous.state !== 'ACTIVE') {
          reservation = await this.#hub.reserveDevice(accountId, {
            workloadKey: bindingKey,
            ...(previous.projectKey ? { projectKey: previous.projectKey } : {}),
            explicitDeviceId: boundDeviceId,
            requiredCapabilities: previous.requiredCapabilities,
            requiredTags: previous.requiredTags,
            minMemoryMb: previous.minMemoryMb,
            requireGpu: previous.requireGpu,
            slots: previous.slots,
            leaseMs: reservationLeaseDuration(previous)
          });
          reservationCreated = true;
        }
      }
      const dispatched = await this.#dispatchWithRecovery({
        accountId,
        explicitDeviceId: boundDeviceId,
        requiredCapabilities: [],
        kind: 'operation',
        payload: { operation: operation.payload, enterpriseContext: relayEnterpriseContext(accountId, projectKey) },
        idempotencyKey: operationIdempotencyKey(accountId, operation.payload)
      });
      delivery = dispatched.delivery;
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
      if (request.aborted || response.destroyed) return;
      const stored = await this.#results.get(routedDeviceId, delivery.seq);
      if (stored && stored.deliveryId === delivery.id) {
        await this.#assertReplayAuthority(accountId, routedDeviceId, stored.replayAuthority);
        const result = stored.result as unknown;
        if (!isOperationTransportResult(result)) {
          send(response, 502, { ok: false, error: { code: 'RELAY_OPERATION_RESULT_INVALID', message: 'Device returned a malformed digital operation result.' } });
          return;
        }
        const state = result.ok && result.operation && typeof result.operation.state === 'string' ? result.operation.state : undefined;
        const terminal = state === 'VERIFIED' || state === 'FAILED' || state === 'CANCELLED';
        if (reservation) {
          if (terminal || (!result.ok && operation.operation === 'submit')) {
            try { await this.#hub.releaseDeviceReservation(accountId, reservation.id); }
            catch (releaseError) {
              const record = await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation, action: 'release', error: releaseError });
              send(response, 200, { ...result, reservationReconciliation: { required: true, action: 'release', recordId: record?.id } });
              return;
            }
          } else if (result.ok) {
            const leaseMs = submitLeaseMs ?? reservationLeaseDuration(reservation);
            try { reservation = await renewReservation(reservation, leaseMs); }
            catch (renewError) {
              const record = await this.#recordReservationFailure({ accountId, operationId: operation.operationId, workloadKey: bindingKey, reservation, action: 'renew', leaseMs, error: renewError });
              send(response, 200, { ...result, reservationReconciliation: { required: true, action: 'renew', recordId: record?.id } });
              return;
            }
          }
        }
        send(response, 200, result);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Timeout is an uncertain transport result: keep the reservation alive so
    // an operation that may already be running is not silently overbooked.
    send(response, 504, { ok: false, error: { code: 'RELAY_OPERATION_RESULT_PENDING', message: 'The routed digital operation has no durable result yet; retry with the same operation UUID.' } });
  }

  async #recordReservationFailure(input: {
    accountId: string;
    operationId: string;
    workloadKey: string;
    reservation: DeviceReservation;
    action: 'renew' | 'release';
    leaseMs?: number;
    error: unknown;
  }): Promise<RelayReservationReconciliation | undefined> {
    const code = safeDiagnosticCode(typeof (input.error as any)?.code === 'string' ? (input.error as any).code : 'RELAY_RESERVATION_BOOKKEEPING_FAILED');
    const record = await this.#reservationReconciliations?.record({
      accountId: input.accountId,
      operationId: input.operationId,
      workloadKey: input.workloadKey,
      reservationId: input.reservation.id,
      sessionId: input.reservation.sessionId,
      action: input.action,
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      errorCode: code
    });
    this.#diagnostic({ service: 'operator-relay-control', status: 'reservation-reconciliation-required', code, action: input.action });
    return record;
  }

  async #recoverReservationReconciliations(): Promise<void> {
    if (!this.#reservationReconciliations) return;
    for (const record of await this.#reservationReconciliations.pending()) {
      try {
        if (record.action === 'release') await this.#hub.releaseDeviceReservation(record.accountId, record.reservationId);
        else {
          const renewed = await this.#hub.heartbeatDeviceReservation(record.accountId, record.reservationId, record.sessionId, record.leaseMs);
          assertExactRenewalReceipt(record, renewed);
        }
        await this.#reservationReconciliations.resolve(record.id);
        this.#diagnostic({ service: 'operator-relay-control', status: 'reservation-reconciled', code: 'RELAY_RESERVATION_RECONCILED', action: record.action });
      } catch {
        // The durable pending record remains authoritative and blocks new work for this workload.
      }
    }
  }

  #diagnostic(event: RelayControlDiagnostic): void {
    try { this.#onDiagnostic?.(event); } catch { /* diagnostics cannot alter control authority */ }
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

/** A successful provider call is not proof of renewing the requested lease.
 * Require exact reservation, session and workload provenance plus active state
 * before retiring a recovery intent or using the renewed reservation for work.
 */
function assertExactRenewalReceipt(
  expected: { id?: string; reservationId?: string; sessionId: string; workloadKey: string },
  renewed: DeviceReservation
): void {
  if (!renewed || renewed.id !== (expected.reservationId ?? expected.id) ||
      renewed.sessionId !== expected.sessionId || renewed.workloadKey !== expected.workloadKey ||
      renewed.state !== 'ACTIVE') {
    throw new OperatorError('RELAY_RESERVATION_RECEIPT_MISMATCH', 'Provider renewal receipt did not prove the exact active reservation contract.');
  }
}

function relayEnterpriseContext(accountId: string, projectKey?: string): { principalId: string; projectKey?: string } {
  const principalId = `account:${validUuid(accountId, 'accountId')}`;
  return { principalId, ...(projectKey ? { projectKey: validProjectKey(projectKey) } : {}) };
}

function safeDiagnosticCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RELAY_CONTROL_FAILED';
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
    case 'controlled-file-change': return ['file.list', 'file.create', 'file.read', 'file.replace', 'git.status'];
    case 'trusted-project-command': return ['project.inspect', 'project.command.inspect', 'project.command.run'];
    case 'project-quality-gate': return ['project.inspect', 'project.command.inspect', 'project.command.run', 'project.transaction.run'];
    case 'browser-navigation': return ['browser.inspect', 'browser.navigate'];
    case 'app-operation': return goal.physicalFallback === undefined
      ? ['app.inspect', 'app.operate']
      : ['app.inspect', 'app.operate', 'visual.capture', 'input.operate'];
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

function validKnowledgeRelayQuery(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'knowledge query must be an object.');
  const raw = structuredClone(input as Record<string, unknown>);
  const kind = String(raw.kind ?? '');
  if (!['procedures', 'procedure-query', 'world-entity', 'world-fact', 'world-trace', 'world-list', 'optimizer'].includes(kind)) {
    throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'knowledge query kind is invalid.');
  }
  const encoded = canonicalJson(raw);
  if (Buffer.byteLength(encoded, 'utf8') > 128 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'knowledge query exceeds bounded size.');
  return raw;
}

function freshKnowledgeReceiptKey(accountId: string, query: Record<string, unknown>): string {
  return crypto.createHash('sha256')
    .update('operator-relay-knowledge-receipt-v1:')
    .update(accountId).update(':').update(canonicalJson(query)).update(':').update(crypto.randomBytes(32))
    .digest('hex');
}

function isKnowledgeTransportResult(input: unknown): input is { ok: boolean } {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input) && typeof (input as Record<string, unknown>).ok === 'boolean');
}

type ValidatedOperationRelayRequest = {
  operation: 'submit' | 'inspect' | 'start' | 'refresh' | 'pause' | 'cancel' | 'promote';
  operationId: string;
  payload: Record<string, unknown>;
  request?: Record<string, unknown>;
};

function validOperationRelayRequest(input: unknown): ValidatedOperationRelayRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation request is required.');
  const raw = input as Record<string, unknown>;
  const operation = String(raw.operation ?? '');
  if (operation === 'submit') {
    if (!raw.request || typeof raw.request !== 'object' || Array.isArray(raw.request)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation submit request is required.');
    const request = structuredClone(raw.request as Record<string, unknown>);
    const operationId = validUuid(String(request.requestId ?? ''), 'operation requestId');
    request.requestId = operationId;
    if (request.device !== undefined) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'Operation request cannot provide device advertisements.');
    const encoded = canonicalJson(request);
    if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation request exceeds bounded size.');
    return { operation: 'submit', operationId, request, payload: { operation: 'submit', request } };
  }
  if (!['inspect', 'start', 'refresh', 'pause', 'cancel', 'promote'].includes(operation)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation control action is invalid.');
  const operationId = validUuid(String(raw.operationId ?? ''), 'operationId');
  if (operation === 'promote') {
    const verificationDigest = String(raw.verificationDigest ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(verificationDigest)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation promotion requires SHA-256 verificationDigest.');
    return { operation: 'promote', operationId, payload: { operation, operationId, verificationDigest } };
  }
  return { operation: operation as ValidatedOperationRelayRequest['operation'], operationId, payload: { operation, operationId } };
}

function operationRequiredCapabilities(request: Record<string, unknown>): string[] {
  const execution = request.execution;
  if (execution === undefined) {
    const requested = new Set<string>();
    const authority = request.authority;
    if (authority !== undefined) {
      if (!authority || typeof authority !== 'object' || Array.isArray(authority)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation authority is invalid.');
      const capabilities = (authority as Record<string, unknown>).capabilities;
      if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 500) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation authority capabilities are invalid.');
      for (const value of capabilities) requested.add(validName(String(value), 'operation authority capability'));
    }
    const procedure = request.procedure;
    if (procedure !== undefined) {
      if (!procedure || typeof procedure !== 'object' || Array.isArray(procedure)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation procedure is invalid.');
      const required = (procedure as Record<string, unknown>).requiredCapabilities;
      if (required !== undefined) {
        if (!Array.isArray(required) || required.length > 200) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'procedure requiredCapabilities are invalid.');
        for (const value of required) requested.add(validName(String(value), 'procedure required capability'));
      }
    }
    return [...requested].sort();
  }
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation execution specification is invalid.');
  const raw = execution as Record<string, unknown>;
  const capabilities = new Set<string>();
  const collect = (workItems: unknown) => {
    if (!Array.isArray(workItems)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation workItems are invalid.');
    for (const item of workItems) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation work item is invalid.');
      const allowed = (item as Record<string, unknown>).allowedCapabilities;
      if (allowed === undefined) continue;
      if (!Array.isArray(allowed) || allowed.length > 200) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation allowedCapabilities are invalid.');
      for (const value of allowed) capabilities.add(validName(String(value), 'allowed capability'));
    }
  };
  if (raw.kind === 'team') collect(raw.workItems);
  else if (raw.kind === 'organization') {
    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 5000) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'organization operation targets are invalid.');
    for (const target of raw.targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'organization target is invalid.');
      collect((target as Record<string, unknown>).workItems);
    }
  } else throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'operation execution kind is invalid.');
  return [...capabilities].sort();
}

function validOperationResourceRequirements(input: unknown): { requiredTags: string[]; minMemoryMb: number; requireGpu: boolean; slots: number } {
  if (input === undefined) return { requiredTags: [], minMemoryMb: 0, requireGpu: false, slots: 1 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'resourceRequirements must be an object.');
  const raw = input as Record<string, unknown>;
  const requiredTags = raw.requiredTags === undefined ? [] : Array.isArray(raw.requiredTags)
    ? raw.requiredTags.map((value) => {
        const tag = String(value ?? '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(tag)) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'resource tag is invalid.');
        return tag;
      })
    : (() => { throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'requiredTags are invalid.'); })();
  if (requiredTags.length > 64 || new Set(requiredTags).size !== requiredTags.length) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'requiredTags are invalid.');
  const minMemoryMb = Number(raw.minMemoryMb ?? 0);
  const slots = Number(raw.slots ?? 1);
  if (!Number.isSafeInteger(minMemoryMb) || minMemoryMb < 0 || minMemoryMb > 1024 * 1024) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'minMemoryMb is invalid.');
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 64) throw new OperatorError('RELAY_CONTROL_INPUT_INVALID', 'slots is invalid.');
  return { requiredTags: requiredTags.sort(), minMemoryMb, requireGpu: raw.requireGpu === true, slots };
}

function operationReservationMatches(
  reservation: DeviceReservation,
  requiredCapabilities: string[],
  requirements: { requiredTags: string[]; minMemoryMb: number; requireGpu: boolean; slots: number }
): boolean {
  return reservation.slots === requirements.slots
    && reservation.minMemoryMb === requirements.minMemoryMb
    && reservation.requireGpu === requirements.requireGpu
    && JSON.stringify(reservation.requiredCapabilities) === JSON.stringify([...requiredCapabilities].sort())
    && JSON.stringify(reservation.requiredTags) === JSON.stringify([...requirements.requiredTags].sort());
}

function reservationLeaseDuration(reservation: DeviceReservation): number {
  const duration = Date.parse(reservation.expiresAt) - Date.parse(reservation.heartbeatAt);
  if (!Number.isFinite(duration)) return 60 * 60_000;
  return Math.max(10 * 60_000, Math.min(24 * 60 * 60_000, Math.floor(duration)));
}

function operationReservationLeaseMs(request: Record<string, unknown>): number {
  const candidates: number[] = [];
  const directBudget = request.budget;
  if (directBudget && typeof directBudget === 'object' && !Array.isArray(directBudget)) {
    const value = Number((directBudget as Record<string, unknown>).maxWallClockMs);
    if (Number.isFinite(value) && value > 0) candidates.push(value);
  }
  const execution = request.execution;
  if (execution && typeof execution === 'object' && !Array.isArray(execution)) {
    const raw = execution as Record<string, unknown>;
    if (raw.kind === 'team' && raw.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget)) {
      const value = Number((raw.budget as Record<string, unknown>).maxWallClockMs);
      if (Number.isFinite(value) && value > 0) candidates.push(value);
    }
    if (raw.kind === 'organization' && raw.policy && typeof raw.policy === 'object' && !Array.isArray(raw.policy)) {
      const teamBudget = (raw.policy as Record<string, unknown>).teamBudget;
      if (teamBudget && typeof teamBudget === 'object' && !Array.isArray(teamBudget)) {
        const value = Number((teamBudget as Record<string, unknown>).maxWallClockMs);
        if (Number.isFinite(value) && value > 0) candidates.push(value);
      }
    }
  }
  const requested = candidates.length > 0 ? Math.max(...candidates) + 5 * 60_000 : 60 * 60_000;
  return Math.max(10 * 60_000, Math.min(24 * 60 * 60_000, Math.floor(requested)));
}

function operationBindingKey(operationId: string): string { return `operation:${validUuid(operationId, 'operationId')}`; }

function operationIdempotencyKey(accountId: string, payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update('operator-relay-operation-receipt-v1:').update(accountId).update(':').update(canonicalJson(payload)).digest('hex');
}

function isOperationTransportResult(input: unknown): input is { ok: boolean; operation?: Record<string, unknown>; error?: { code?: string; message?: string } } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const raw = input as Record<string, unknown>;
  if (typeof raw.ok !== 'boolean') return false;
  if (raw.ok) return Boolean(raw.operation && typeof raw.operation === 'object' && !Array.isArray(raw.operation));
  if (!raw.error || typeof raw.error !== 'object' || Array.isArray(raw.error)) return false;
  const error = raw.error as Record<string, unknown>;
  return typeof error.code === 'string' && typeof error.message === 'string';
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

function isRecoverableRelayDispatchError(error: OperatorError): boolean {
  if (error.code === 'ROUTE_NO_DEVICE') return true;
  if (!error.retryable) return false;
  return error.code === 'RELAY_TRANSPORT_UNAVAILABLE' || error.code === 'ROUTE_DEVICE_OFFLINE';
}

function relayRecoveryDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(Math.trunc(attempt), 0), 4);
  const base = Math.min(TRANSPORT_RECOVERY_MAX_DELAY_MS, 75 * (2 ** exponent));
  const jitter = crypto.randomInt(0, Math.max(1, Math.floor(base / 3) + 1));
  return base + jitter;
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
