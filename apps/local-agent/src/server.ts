import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { applyBoundedHttpServerPolicy, requireLiteralLoopbackBindHost } from '../../../src/core/network-authority.ts';
import { PRODUCT_VERSION } from '../../../src/core/product-identity.ts';
import type { ActionRequest, ActionResult, PermissionProfile } from '../../../src/core/types.ts';
import type { OperatorRuntime } from '../../../src/core/runtime.ts';
import type { AgentKernel } from '../../../src/core/agent-kernel.ts';
import { validIntentBinding, type IntentRegistry } from '../../../src/core/intent-registry.ts';
import type { DurableSagaKernel } from '../../../src/core/durable-saga.ts';
import type { AuditLog } from '../../../src/core/audit.ts';
import type { TaskStore } from '../../../src/core/task-store.ts';
import type { TaskOrchestrator, SemanticTaskGoal, SubmitTaskOptions } from '../../../src/core/task-orchestrator.ts';
import type { TeamCoordinator, TeamRole, TeamWorkInput } from '../../../src/core/team-coordinator.ts';
import type { ProcedureMemoryStore } from '../../../src/core/procedure-memory.ts';
import { validateWorldObservation, type WorldModelStore } from '../../../src/core/world-model.ts';
import type { DevicePoolScheduler } from '../../../src/core/device-pool.ts';
import type { ExecutionOptimizerStore } from '../../../src/core/execution-optimizer.ts';
import type { OrganizationCoordinator } from '../../../src/core/organization-coordinator.ts';
import type { DigitalOperationsLayer, DigitalOperationSubmit } from '../../../src/core/digital-operations.ts';
import type { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import type { DeviceRegistryStore } from '../../../src/core/device-registry.ts';
import type { EmergencyStopStore } from './emergency-stop.ts';
import type { ApprovalAuthorityContext, ApprovalStore } from './approval-store.ts';
import type { LocalActionExecutionStore } from './action-execution-store.ts';
import type { SessionApprovalStore } from './session-approval.ts';
import type { LocalPrivacyDataStore, PrivacyCategory } from './privacy-data.ts';
import type { LocalDeviceResetResult } from './device-reset.ts';
import { renderControlCenter } from './control-center.ts';
import { resourceKeysForAction } from '../../../src/core/resource-identity.ts';
import type { EnterpriseAuthorizationContext, EnterprisePolicyStore } from '../../../src/core/enterprise-policy.ts';
import type { TeachModeStore } from '../../../src/core/studio-teach.ts';
import type { DesiredStateController } from '../../../src/core/desired-state.ts';
import type { DurableEventRuntime } from '../../../src/core/event-runtime.ts';
import type { PerceptionGraphStore } from '../../../src/core/perception-graph.ts';
import { publishPerceptionFromActionResult } from '../../../src/core/perception-publication.ts';
import type { StudioWorkflowExecutor } from '../../../src/core/studio-executor.ts';
import { semanticCheckpointDigest, type SemanticCheckpointManager, type SignedSemanticCheckpoint } from '../../../src/core/semantic-checkpoint.ts';
import { projectTaskRuntime } from '../../../src/core/runtime-projection.ts';
import { buildApprovalCenterModel, buildGuidedOnboardingModel, buildRecoveryCenterModel, type RecoveryCandidateInput } from '../../../src/core/control-center-ux.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import {
  boundedString,
  decodeEnterpriseContextHeader,
  readJson,
  relayRequestMarker,
  timingSafeSecretMatch,
  timingSafeTokenMatch,
  validateActionEnvelope,
  validateApprovalAuthority
} from './server-boundary.ts';
import {
  assertMigrationCapabilities,
  buildMigrationArtifacts,
  buildMigrationWorldAssumptions,
  hashAuthorizedMigrationArtifact,
  migrationAuthorityDigest,
  verifyMigrationResourceKey,
  verifyMigrationWorldAssumption
} from './migration-proofs.ts';

// Stay below the official MCP client's default ~60s request budget so approval can never execute after the caller has already timed out.
const MAX_INLINE_APPROVAL_WAIT_MS = 45_000;

type CompanionSettings = Record<string, boolean | number | string | string[]>;

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

function sendControlCenter(res: http.ServerResponse): void {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const body = renderControlCenter(nonce);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; connect-src 'self'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  });
  res.end(body);
}

export function createLocalAgentServer(options: {
  runtime: OperatorRuntime;
  agentKernel?: AgentKernel;
  intentRegistry?: IntentRegistry;
  sagas?: DurableSagaKernel;
  token: string;
  permissions: PermissionProfile;
  emergencyStop?: EmergencyStopStore;
  approvals?: ApprovalStore;
  actionExecutions?: LocalActionExecutionStore;
  beforeActionReceiptCompletion?: (input: { action: ActionRequest; result: ActionResult }) => Promise<void> | void;
  sessionApprovals?: SessionApprovalStore;
  recoveryToken?: string;
  onEmergencyStop?: () => Promise<void> | void;
  onEmergencyClear?: () => Promise<void> | void;
  audit?: AuditLog;
  tasks?: TaskStore;
  taskOrchestrator?: TaskOrchestrator;
  teams?: TeamCoordinator;
  procedures?: ProcedureMemoryStore;
  world?: WorldModelStore;
  devicePool?: DevicePoolScheduler;
  optimizer?: ExecutionOptimizerStore;
  organizations?: OrganizationCoordinator;
  operations?: DigitalOperationsLayer;
  events?: DurableEventRuntime;
  perception?: PerceptionGraphStore;
  teachMode?: TeachModeStore;
  studioExecutor?: StudioWorkflowExecutor;
  semanticMigration?: SemanticCheckpointManager;
  enterprisePolicy?: EnterprisePolicyStore;
  desiredState?: DesiredStateController;
  deviceIdentity?: DeviceIdentityStore;
  deviceRegistry?: DeviceRegistryStore;
  settings?: CompanionSettings;
  getRuntimeStatus?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  privacy?: LocalPrivacyDataStore;
  deviceReset?: () => Promise<LocalDeviceResetResult>;
  inlineApprovalWaitMs?: number;
}) {
  if (options.token.length < 32) throw new Error('Agent token must be at least 32 characters.');
  if (options.recoveryToken !== undefined && options.recoveryToken.length < 32) throw new Error('Recovery token must be at least 32 characters.');
  const inlineApprovalWaitMs = options.inlineApprovalWaitMs ?? MAX_INLINE_APPROVAL_WAIT_MS;
  if (!Number.isInteger(inlineApprovalWaitMs) || inlineApprovalWaitMs < 10 || inlineApprovalWaitMs > MAX_INLINE_APPROVAL_WAIT_MS) {
    throw new Error(`inlineApprovalWaitMs must be an integer between 10 and ${MAX_INLINE_APPROVAL_WAIT_MS}.`);
  }

  type InlineApprovalDecision = 'approve' | 'session' | 'deny';
  type InlineApprovalWaiter = {
    approvalRequestId: string;
    resolve: (decision: InlineApprovalDecision | null) => void;
    timer: NodeJS.Timeout;
  };
  const approvalWaiters = new Map<string, Set<InlineApprovalWaiter>>();
  const activeTeamActions = new Map<string, { missionId: string; workItemId: string; workerId: string; controller: AbortController }>();
  let emergencyExecutionGeneration = new AbortController();

  const abortTeamActions = (predicate: (entry: { missionId: string; workItemId: string; workerId: string }) => boolean) => {
    const aborted: Array<{ missionId: string; workItemId: string; workerId: string }> = [];
    for (const [key, entry] of activeTeamActions) {
      if (!predicate(entry)) continue;
      aborted.push({ missionId: entry.missionId, workItemId: entry.workItemId, workerId: entry.workerId });
      entry.controller.abort('EMERGENCY_STOPPED');
      activeTeamActions.delete(key);
    }
    return aborted;
  };

  const notifyApprovalDecision = (actionId: string, approvalRequestId: string, decision: InlineApprovalDecision): number => {
    const waiters = approvalWaiters.get(actionId);
    if (!waiters) return 0;
    let notified = 0;
    for (const waiter of [...waiters]) {
      if (waiter.approvalRequestId !== approvalRequestId) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(decision);
      notified += 1;
    }
    if (waiters.size === 0) approvalWaiters.delete(actionId);
    return notified;
  };

  const waitForApprovalDecision = (
    actionId: string,
    approvalRequestId: string,
    maxWaitMs = inlineApprovalWaitMs
  ): Promise<InlineApprovalDecision | null> => {
    const waitMs = Math.min(inlineApprovalWaitMs, Math.max(0, Math.floor(maxWaitMs)));
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiters = approvalWaiters.get(actionId) ?? new Set<InlineApprovalWaiter>();
      const waiter: InlineApprovalWaiter = {
        approvalRequestId,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) approvalWaiters.delete(actionId);
          resolve(null);
        }, waitMs)
      };
      waiter.timer.unref?.();
      waiters.add(waiter);
      approvalWaiters.set(actionId, waiters);
    });
  };

  const clearApprovalWaiters = () => {
    for (const waiters of approvalWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    approvalWaiters.clear();
  };

  const abortEmergencyExecutions = () => {
    if (!emergencyExecutionGeneration.signal.aborted) {
      emergencyExecutionGeneration.abort('EMERGENCY_STOPPED');
    }
    const teamActions = abortTeamActions(() => true);
    const taskIds = options.taskOrchestrator?.emergencyStopActive() ?? [];
    clearApprovalWaiters();
    return { teamActions, taskIds };
  };

  const resetEmergencyExecutionGeneration = () => {
    emergencyExecutionGeneration = new AbortController();
  };

  const executeActionWithCurrentApproval = async (
    action: ActionRequest,
    approvalAuthority: ApprovalAuthorityContext | undefined,
    signal?: AbortSignal,
    basePermissions: PermissionProfile = options.permissions
  ): Promise<ActionResult> => {
    const emergencySignal = emergencyExecutionGeneration.signal;
    const executionSignal = signal ? AbortSignal.any([signal, emergencySignal]) : emergencySignal;
    let approvalLeaseId: string | null = null;
    if (options.approvals) {
      try {
        approvalLeaseId = await options.approvals.claim(action, approvalAuthority);
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'APPROVAL_IN_USE') {
          return {
            ok: false,
            capability: action.capability,
            provider: 'policy',
            evidence: [{ kind: 'approval', status: 'info', message: 'This approved action is already executing.', timestamp: new Date().toISOString() }],
            error: { code: error.code, message: error.message, retryable: true, sideEffectState: 'none' },
            durationMs: 0
          };
        }
        throw error;
      }
    }
    const sessionPermissions = options.sessionApprovals
      ? options.sessionApprovals.permissionsFor(approvalAuthority, basePermissions)
      : basePermissions;
    const permissions = approvalLeaseId
      ? {
          ...sessionPermissions,
          approvedActionIds: [...new Set([...(sessionPermissions.approvedActionIds ?? []), action.id])]
        }
      : sessionPermissions;
    let result: ActionResult;
    try {
      result = options.agentKernel
        ? await options.agentKernel.execute(action, permissions, { signal: executionSignal })
        : await options.runtime.execute(action, permissions, { signal: executionSignal });
    } catch (error) {
      if (approvalLeaseId) {
        await options.approvals!.settle(action, approvalLeaseId, 'consume', approvalAuthority);
      }
      throw error;
    }
    if (approvalLeaseId) {
      const outcome = !result.ok && result.error?.sideEffectState === 'none' ? 'release' : 'consume';
      await options.approvals!.settle(action, approvalLeaseId, outcome, approvalAuthority);
    }
    if (options.perception && !options.agentKernel) {
      try {
        await publishPerceptionFromActionResult(options.perception, action, result);
      } catch (error) {
        await options.audit?.append({
          ...(action.taskId ? { traceId: action.taskId, taskId: action.taskId } : {}),
          actionId: action.id,
          providerId: 'perception.graph',
          capability: 'perception.publish',
          result: 'failure',
          risk: 'write',
          details: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'PERCEPTION_PUBLICATION_FAILED' }
        });
      }
    }
    return result;
  };

  const executeStudioActionWithApproval = async (
    action: ActionRequest,
    approvalAuthority: ApprovalAuthorityContext | undefined,
    signal?: AbortSignal
  ): Promise<ActionResult> => {
    if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
      return {
        ok: false,
        capability: action.capability,
        provider: 'policy',
        evidence: [{ kind: 'emergency_stop', status: 'fail', message: 'Operator execution is disabled by the local emergency stop.', timestamp: new Date().toISOString() }],
        error: { code: 'EMERGENCY_STOPPED', message: 'Operator execution is disabled by the local emergency stop.', retryable: false, sideEffectState: 'none' },
        durationMs: 0
      };
    }

    let result = await executeActionWithCurrentApproval(action, approvalAuthority, signal);
    let autoResumedAfterApproval = false;
    if (result.provider === 'policy' && result.error?.code === 'APPROVAL_REQUIRED' && options.approvals) {
      const pending = await options.approvals.register(action, approvalAuthority);
      const decision = options.recoveryToken
        ? await waitForApprovalDecision(action.id, pending.approvalRequestId, Math.min(inlineApprovalWaitMs, 30_000))
        : null;
      if (decision === 'approve' || decision === 'session') {
        result = await executeActionWithCurrentApproval(action, approvalAuthority, signal);
        autoResumedAfterApproval = true;
      } else if (decision === 'deny') {
        result = {
          ok: false,
          capability: action.capability,
          provider: 'policy',
          evidence: [{ kind: 'approval', status: 'fail', message: 'The local user denied this Studio workflow action.', timestamp: new Date().toISOString() }],
          error: { code: 'APPROVAL_DENIED', message: 'The local user denied this Studio workflow action.', retryable: false, sideEffectState: 'none' },
          durationMs: result.durationMs
        };
      }
    }

    try {
      await options.audit?.append({
        ...(action.taskId ? { traceId: action.taskId, taskId: action.taskId } : {}),
        actionId: action.id, providerId: result.provider, capability: action.capability, target: action.target,
        result: result.ok ? 'success' : result.provider === 'policy' ? 'blocked' : 'failure', risk: action.risk,
        details: { studioWorkflow: true, durationMs: result.durationMs, errorCode: result.error?.code, sideEffectState: result.error?.sideEffectState, autoResumedAfterApproval }
      });
    } catch (error) {
      result = resultWithAuditDegradation(result, error);
    }
    return result;
  };

  const taskAuthorization = (authority?: ApprovalAuthorityContext, basePermissions: PermissionProfile = options.permissions) => {
    const approvalLeases = new Map<string, string>();
    return {
      permissionProvider: async (action: ActionRequest) => {
        const executionLeaseId = options.approvals ? await options.approvals.claim(action, authority) : null;
        const sessionPermissions = options.sessionApprovals
          ? options.sessionApprovals.permissionsFor(authority, basePermissions)
          : basePermissions;
        if (!executionLeaseId) return sessionPermissions;
        approvalLeases.set(action.id, executionLeaseId);
        return {
          ...sessionPermissions,
          approvedActionIds: [...new Set([...(sessionPermissions.approvedActionIds ?? []), action.id])]
        };
      },
      onActionResult: async (action: ActionRequest, result: ActionResult) => {
        const executionLeaseId = approvalLeases.get(action.id);
        if (!executionLeaseId || !options.approvals) return;
        approvalLeases.delete(action.id);
        const outcome = !result.ok && result.error?.sideEffectState === 'none' ? 'release' : 'consume';
        await options.approvals.settle(action, executionLeaseId, outcome, authority);
      },
      onApprovalRequired: async (action: ActionRequest, remainingMs: number) => {
        if (!options.approvals) return undefined;
        const pending = await options.approvals.register(action, authority);
        if (!options.recoveryToken) return undefined;
        const decision = await waitForApprovalDecision(action.id, pending.approvalRequestId, remainingMs);
        if (decision === 'approve' || decision === 'session') return 'retry' as const;
        if (decision === 'deny') return 'deny' as const;
        return undefined;
      }
    };
  };

  const permissionsForRequest = async (
    relayRequest: boolean,
    enterpriseContext: EnterpriseAuthorizationContext | undefined
  ): Promise<{ permissions: PermissionProfile; enterpriseApplied: boolean; roleIds: string[]; bindingIds: string[] }> => {
    if (!relayRequest || !options.enterprisePolicy || !await options.enterprisePolicy.isConfigured()) {
      return { permissions: options.permissions, enterpriseApplied: false, roleIds: [], bindingIds: [] };
    }
    if (!enterpriseContext) {
      throw new OperatorError('ENTERPRISE_CONTEXT_REQUIRED', 'Configured enterprise policy requires trusted relay enterprise context.');
    }
    const decision = await options.enterprisePolicy.narrow(options.permissions, enterpriseContext);
    return {
      permissions: decision.permissions,
      enterpriseApplied: true,
      roleIds: decision.roleIds,
      bindingIds: decision.bindingIds
    };
  };

  const assertEnterpriseApprovalBinding = (
    relayRequest: boolean,
    enterpriseContext: EnterpriseAuthorizationContext | undefined,
    approvalAuthority: ApprovalAuthorityContext | undefined
  ): void => {
    if (!relayRequest || !enterpriseContext || !approvalAuthority) return;
    if (enterpriseContext.principalId !== `account:${approvalAuthority.accountId}`
      || enterpriseContext.deviceId !== approvalAuthority.deviceId) {
      throw new OperatorError('ENTERPRISE_CONTEXT_AUTHORITY_MISMATCH', 'Enterprise context does not match relay-stamped account/device authority.');
    }
  };

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://operator.local');
    const requestedPathname = requestUrl.pathname;
    // Stage-3 goal API is a semantic alias over the same durable Task Capsule store.
    // This avoids a second source of truth while giving goal-oriented clients a stable control-plane route.
    const pathname = requestedPathname === '/v1/goals' || requestedPathname.startsWith('/v1/goals/')
      ? requestedPathname.replace(/^\/v1\/goals/, '/v1/tasks')
      : requestedPathname;

    if (pathname === '/health' && req.method === 'GET') {
      const emergencyStopped = options.emergencyStop ? (await options.emergencyStop.status()).engaged : false;
      send(res, 200, { ok: true, service: 'operator-local-agent', version: PRODUCT_VERSION, emergencyStopped });
      return;
    }

    // The Control Center shell contains no device data or credentials. All API
    // requests it makes still pass through the bearer-token boundary below.
    if (pathname === '/control-center' && req.method === 'GET') {
      sendControlCenter(res);
      return;
    }

    if (!timingSafeTokenMatch(req.headers.authorization, options.token)) {
      send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid agent bearer token required.' } });
      return;
    }

    let relayRequest = false;
    let requestEnterpriseContext: EnterpriseAuthorizationContext | undefined;
    let requestPermissionDecision: { permissions: PermissionProfile; enterpriseApplied: boolean; roleIds: string[]; bindingIds: string[] };
    try {
      relayRequest = relayRequestMarker(req.headers['x-operator-relay-request']);
      requestEnterpriseContext = decodeEnterpriseContextHeader(req.headers['x-operator-enterprise-context'], relayRequest);
      requestPermissionDecision = await permissionsForRequest(relayRequest, requestEnterpriseContext);
    } catch (error) {
      const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'ENTERPRISE_CONTEXT_INVALID';
      send(res, code === 'ENTERPRISE_AUTHORITY_DENIED' || code === 'ENTERPRISE_CONTEXT_REQUIRED' ? 403 : 400, {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) }
      });
      return;
    }
    const requestPermissions = requestPermissionDecision.permissions;

    const intentRoute = /^\/v1\/intents\/([A-Za-z0-9._:-]{1,128})$/.exec(pathname);
    if (intentRoute && req.method === 'GET') {
      if (!options.intentRegistry) {
        send(res, 503, { ok: false, error: { code: 'INTENT_REGISTRY_NOT_CONFIGURED', message: 'Intent registry is not configured.' } });
        return;
      }
      try {
        const intent = await options.intentRegistry.current(intentRoute[1]!);
        send(res, intent ? 200 : 404, intent
          ? { ok: true, intent }
          : { ok: false, error: { code: 'INTENT_NOT_FOUND', message: 'No current intent exists for this conversation.' } });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'INTENT_READ_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (intentRoute && req.method === 'POST') {
      if (!options.intentRegistry) {
        send(res, 503, { ok: false, error: { code: 'INTENT_REGISTRY_NOT_CONFIGURED', message: 'Intent registry is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const directive = String(body.directive ?? 'continue');
        if (!['continue','refine','extend','pause','cancel','redirect','authorize','revoke'].includes(directive)) {
          throw new OperatorError('INTENT_INPUT_INVALID', 'Intent directive is invalid.');
        }
        const intent = await options.intentRegistry.update(intentRoute[1]!, {
          objective: String(body.objective ?? ''),
          authorizedScope: Array.isArray(body.authorizedScope) ? body.authorizedScope.map(String) : [],
          prohibitedScope: Array.isArray(body.prohibitedScope) ? body.prohibitedScope.map(String) : [],
          directive: directive as 'continue' | 'refine' | 'extend' | 'pause' | 'cancel' | 'redirect' | 'authorize' | 'revoke',
          sourceTurnId: String(body.sourceTurnId ?? '')
        });
        send(res, 200, {
          ok: true,
          intent,
          binding: {
            conversationId: intent.conversationId,
            intentVersion: intent.intentVersion,
            digest: intent.digest
          }
        });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'INTENT_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/sagas' && req.method === 'GET') {
      if (!options.sagas) {
        send(res, 503, { ok: false, error: { code: 'SAGA_KERNEL_NOT_CONFIGURED', message: 'Durable saga kernel is not configured.' } });
        return;
      }
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, sagas: await options.sagas.list(limit) });
      return;
    }

    if (pathname === '/v1/sagas' && req.method === 'POST') {
      if (!options.sagas) {
        send(res, 503, { ok: false, error: { code: 'SAGA_KERNEL_NOT_CONFIGURED', message: 'Durable saga kernel is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const rawSteps = Array.isArray(body.steps) ? body.steps : [];
        const steps = rawSteps.map((value, index) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`steps[${index}] must be an object.`);
          const raw = value as Record<string, unknown>;
          return {
            key: boundedString(raw.key, `steps[${index}].key`, 128),
            action: validateActionEnvelope(raw.action),
            ...(raw.compensation === undefined ? {} : { compensation: validateActionEnvelope(raw.compensation) })
          };
        });
        const submitted = await options.sagas.submit({
          ...(body.sagaId === undefined ? {} : { sagaId: String(body.sagaId) }),
          objective: String(body.objective ?? ''),
          ...(body.intent && typeof body.intent === 'object' ? { intent: validIntentBinding(body.intent) } : {}),
          steps
        });
        if (body.run === true) {
          if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
            send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Saga execution is disabled by the local emergency stop.' } });
            return;
          }
          const saga = await options.sagas.run(submitted.id);
          send(res, 200, { ok: true, saga });
          return;
        }
        send(res, 202, { ok: true, saga: submitted });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SAGA_SUBMISSION_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const sagaRoute = /^\/v1\/sagas\/([0-9a-f-]{36})$/.exec(pathname);
    if (sagaRoute && req.method === 'GET') {
      if (!options.sagas) {
        send(res, 503, { ok: false, error: { code: 'SAGA_KERNEL_NOT_CONFIGURED', message: 'Durable saga kernel is not configured.' } });
        return;
      }
      try {
        send(res, 200, { ok: true, saga: await options.sagas.inspect(sagaRoute[1]!) });
      } catch (error) {
        send(res, 404, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SAGA_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const sagaRunRoute = /^\/v1\/sagas\/([0-9a-f-]{36})\/run$/.exec(pathname);
    if (sagaRunRoute && req.method === 'POST') {
      if (!options.sagas) {
        send(res, 503, { ok: false, error: { code: 'SAGA_KERNEL_NOT_CONFIGURED', message: 'Durable saga kernel is not configured.' } });
        return;
      }
      if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
        send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Saga execution is disabled by the local emergency stop.' } });
        return;
      }
      try {
        send(res, 200, { ok: true, saga: await options.sagas.run(sagaRunRoute[1]!) });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SAGA_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/enterprise-policy' && req.method === 'GET') {
      if (!options.enterprisePolicy) {
        send(res, 503, { ok: false, error: { code: 'ENTERPRISE_POLICY_NOT_CONFIGURED', message: 'Enterprise policy store is not configured.' } });
        return;
      }
      send(res, 200, {
        ok: true,
        configured: await options.enterprisePolicy.isConfigured(),
        policy: await options.enterprisePolicy.inspect()
      });
      return;
    }

    if (pathname === '/v1/enterprise-policy' && req.method === 'PUT') {
      if (!options.enterprisePolicy || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'ENTERPRISE_POLICY_ADMIN_NOT_CONFIGURED', message: 'Enterprise policy administration requires local recovery authority.' } });
        return;
      }
      if (relayRequest) {
        send(res, 403, { ok: false, error: { code: 'ENTERPRISE_POLICY_LOCAL_ADMIN_REQUIRED', message: 'Enterprise policy changes are local-admin-only and cannot be performed through relay execution.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const roles = Array.isArray(body.roles) ? body.roles as any : [];
        const bindings = Array.isArray(body.bindings) ? body.bindings as any : [];
        const configured = await options.enterprisePolicy.configure({ roles, bindings });
        await options.audit?.append({
          capability: 'enterprise.policy.configure',
          result: 'success',
          risk: 'system',
          details: { roleCount: roles.length, bindingCount: bindings.length, policyGeneration: configured.generation }
        });
        send(res, 200, { ok: true, configured: await options.enterprisePolicy.isConfigured(), generation: configured.generation });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'ENTERPRISE_POLICY_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/activity' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      const query = {
        limit,
        ...(requestUrl.searchParams.get('traceId') ? { traceId: requestUrl.searchParams.get('traceId')! } : {}),
        ...(requestUrl.searchParams.get('operationId') ? { operationId: requestUrl.searchParams.get('operationId')! } : {}),
        ...(requestUrl.searchParams.get('taskId') ? { taskId: requestUrl.searchParams.get('taskId')! } : {}),
        ...(requestUrl.searchParams.get('missionId') ? { missionId: requestUrl.searchParams.get('missionId')! } : {}),
        ...(requestUrl.searchParams.get('workerId') ? { workerId: requestUrl.searchParams.get('workerId')! } : {}),
        ...(requestUrl.searchParams.get('capability') ? { capability: requestUrl.searchParams.get('capability')! } : {})
      };
      send(res, 200, { ok: true, events: options.audit ? await options.audit.query(query) : [], configured: Boolean(options.audit) });
      return;
    }

    if (pathname === '/v1/activity/summary' && req.method === 'GET') {
      send(res, 200, { ok: true, summary: options.audit ? await options.audit.summary() : null, configured: Boolean(options.audit) });
      return;
    }

    if (pathname === '/v1/control-center/runtime' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 100;
      const [summaries, journal, approvals] = await Promise.all([
        options.tasks ? options.tasks.list(limit) : [],
        options.agentKernel ? options.agentKernel.journal.list(Math.min(1000, limit * 5)) : [],
        options.approvals ? options.approvals.list() : []
      ]);
      const tasks = options.tasks
        ? await Promise.all(summaries.map((summary) => options.tasks!.get(summary.id)))
        : [];
      send(res, 200, {
        ok: true,
        projections: tasks.map((task) => projectTaskRuntime(task, { journal, approvals })),
        configured: Boolean(options.tasks)
      });
      return;
    }

    if (pathname === '/v1/control-center/approvals' && req.method === 'GET') {
      const records = options.approvals ? await options.approvals.list() : [];
      send(res, 200, {
        ok: true,
        model: buildApprovalCenterModel(records),
        session: options.sessionApprovals?.summary() ?? { active: false },
        configured: Boolean(options.approvals)
      });
      return;
    }

    if (pathname === '/v1/control-center/recovery' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 100;
      const [summaries, journal, approvals] = await Promise.all([
        options.tasks ? options.tasks.list(limit) : [],
        options.agentKernel ? options.agentKernel.journal.list(Math.min(1000, limit * 5)) : [],
        options.approvals ? options.approvals.list() : []
      ]);
      const tasks = options.tasks
        ? await Promise.all(summaries.map((summary) => options.tasks!.get(summary.id)))
        : [];
      const projections = tasks.map((task) => projectTaskRuntime(task, { journal, approvals }));
      const candidates: RecoveryCandidateInput[] = projections.flatMap((projection) => {
        const current = projection.currentAction;
        if (!current) return [];
        const sideEffectState = current.sideEffectState === 'known' || current.sideEffectState === 'uncertain'
          ? current.sideEffectState : 'none';
        const executionPhase = ['pre_dispatch','dispatched','effect_observed','reconciled'].includes(String(current.executionPhase ?? ''))
          ? current.executionPhase as RecoveryCandidateInput['executionPhase'] : undefined;
        const verificationStatus: RecoveryCandidateInput['verificationStatus'] =
          projection.verification.state === 'verified' ? 'passed'
            : projection.verification.state === 'failed' ? 'failed' : 'unknown';
        // Task/action projections do not currently carry an authoritative retryable bit.
        // R4 must never synthesize retry authority from "failed + no observed effect";
        // until the execution contract exposes it explicitly, recovery remains escalation-only.
        const retryable = false;
        const reconciliationStatus: RecoveryCandidateInput['reconciliationStatus'] =
          projection.reconciliationRequired ? undefined
            : sideEffectState === 'none' ? 'not_applied'
              : verificationStatus === 'passed' ? 'completed' : undefined;
        return [{
          actionId: current.actionId,
          capability: current.capability,
          retryable,
          sideEffectState,
          ...(executionPhase ? { executionPhase } : {}),
          ...(reconciliationStatus ? { reconciliationStatus } : {}),
          rollbackAvailable: projection.compensation.state === 'pending',
          verificationStatus,
          ...(current.errorCode || projection.blocker?.code ? { code: current.errorCode ?? projection.blocker!.code } : {}),
          updatedAt: projection.active.updatedAt
        }];
      });
      send(res, 200, {
        ok: true,
        model: buildRecoveryCenterModel(candidates),
        configured: Boolean(options.tasks)
      });
      return;
    }

    if (pathname === '/v1/control-center/onboarding' && req.method === 'GET') {
      const [local, summaries, approvals] = await Promise.all([
        options.deviceIdentity ? options.deviceIdentity.loadExisting() : Promise.resolve(null),
        options.tasks ? options.tasks.list(200) : Promise.resolve([]),
        options.approvals ? options.approvals.list() : Promise.resolve([])
      ]);
      const tasks = options.tasks
        ? await Promise.all(summaries.map((summary) => options.tasks!.get(summary.id)))
        : [];
      const readProbePassed = tasks.some((task) =>
        (task.execution?.records ?? []).some((record) => record.risk === 'read' && record.state === 'SUCCEEDED'));
      const approvalProbePassed = approvals.some((record) => record.status === 'consumed' || record.status === 'denied');
      const guidedTaskVerified = tasks.some((task) => task.state === 'VERIFIED');
      send(res, 200, {
        ok: true,
        model: buildGuidedOnboardingModel({
          runtimeInstalled: true,
          doctorHealthy: true,
          authenticated: true,
          devicePaired: Boolean(local),
          rootsConfigured: options.permissions.allowedRoots.length > 0,
          readProbePassed,
          approvalProbePassed,
          guidedTaskVerified
        }),
        evidence: {
          runtimeInstalled: 'local-agent-serving',
          doctorHealthy: 'authenticated-health-boundary',
          authenticated: 'bearer-token-accepted',
          devicePaired: Boolean(local),
          configuredRootCount: options.permissions.allowedRoots.length,
          readProbePassed,
          approvalProbePassed,
          guidedTaskVerified
        }
      });
      return;
    }

    if (pathname === '/v1/control-center/diagnostics' && req.method === 'GET') {
      const [runtime, emergency, local, peers, summaries, approvals] = await Promise.all([
        options.getRuntimeStatus ? options.getRuntimeStatus() : Promise.resolve({}),
        options.emergencyStop ? options.emergencyStop.status() : Promise.resolve({ version: 1, engaged: false }),
        options.deviceIdentity ? options.deviceIdentity.loadExisting() : Promise.resolve(null),
        options.deviceRegistry ? options.deviceRegistry.listDevices() : Promise.resolve([]),
        options.tasks ? options.tasks.list(500) : Promise.resolve([]),
        options.approvals ? options.approvals.list() : Promise.resolve([])
      ]);
      const taskCounts = summaries.reduce<Record<string, number>>((acc, task) => {
        acc[task.state] = (acc[task.state] ?? 0) + 1;
        return acc;
      }, {});
      const approvalModel = buildApprovalCenterModel(approvals);
      const relay = runtime && typeof runtime === 'object' && !Array.isArray(runtime)
        ? (runtime as Record<string, unknown>).relay : undefined;
      const relayState = relay && typeof relay === 'object' && !Array.isArray(relay)
        ? String((relay as Record<string, unknown>).state ?? '') : '';
      const issues: Array<{ code: string; severity: 'info' | 'warning' | 'critical'; guidance: string }> = [];
      if (!options.recoveryToken) issues.push({ code: 'RECOVERY_NOT_CONFIGURED', severity: 'warning', guidance: 'Configure local recovery authority before approvals, emergency recovery, or protected administration.' });
      if (!local) issues.push({ code: 'DEVICE_IDENTITY_MISSING', severity: 'warning', guidance: 'Pair this device before remote operation.' });
      if (options.permissions.allowedRoots.length === 0) issues.push({ code: 'NO_AUTHORIZED_ROOTS', severity: 'warning', guidance: 'Choose at least one authorized workspace root.' });
      if ((emergency as { engaged?: boolean }).engaged) issues.push({ code: 'EMERGENCY_STOP_ENGAGED', severity: 'critical', guidance: 'Review the stop reason and clear it only through local recovery authority.' });
      if (relayState === 'DEGRADED' || relayState === 'OFFLINE') issues.push({ code: 'RELAY_DEGRADED', severity: 'warning', guidance: 'Remote continuity is degraded; local runtime remains authoritative.' });
      if (approvalModel.counts.pending > 0) issues.push({ code: 'APPROVALS_PENDING', severity: 'info', guidance: 'Review pending effects in Approval Center.' });
      send(res, 200, {
        ok: true,
        diagnostics: {
          schemaVersion: 1,
          service: 'operator-local-agent',
          productVersion: PRODUCT_VERSION,
          emergencyStopped: Boolean((emergency as { engaged?: boolean }).engaged),
          recoveryConfigured: Boolean(options.recoveryToken),
          authorizedRootCount: options.permissions.allowedRoots.length,
          device: local ? { configured: true, deviceName: local.deviceName } : { configured: false },
          peerCounts: {
            total: peers.length,
            active: peers.filter((peer) => peer.status === 'active').length,
            revoked: peers.filter((peer) => peer.status === 'revoked').length
          },
          taskCounts,
          approvalCounts: approvalModel.counts,
          runtime,
          issues
        }
      });
      return;
    }


    if (pathname === '/v1/events/waits' && req.method === 'POST') {
      if (!options.events) {
        send(res, 503, { ok: false, error: { code: 'EVENT_RUNTIME_NOT_CONFIGURED', message: 'Durable event runtime is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const wait = await options.events.wait({
          ...(body.waitId === undefined ? {} : { waitId: String(body.waitId) }),
          eventType: String(body.eventType ?? ''),
          ...(body.correlationKey === undefined ? {} : { correlationKey: String(body.correlationKey) }),
          ...(body.notBefore === undefined ? {} : { notBefore: String(body.notBefore) }),
          ...(body.deadlineAt === undefined ? {} : { deadlineAt: String(body.deadlineAt) }),
          ...(body.wakeAt === undefined ? {} : { wakeAt: String(body.wakeAt) })
        });
        send(res, 201, { ok: true, wait });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'EVENT_WAIT_CREATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const eventWaitRoute = /^\/v1\/events\/waits\/([0-9a-f-]{36})(?:\/(cancel))?$/i.exec(pathname);
    if (eventWaitRoute) {
      if (!options.events) {
        send(res, 503, { ok: false, error: { code: 'EVENT_RUNTIME_NOT_CONFIGURED', message: 'Durable event runtime is not configured.' } });
        return;
      }
      try {
        const waitId = eventWaitRoute[1]!;
        if (!eventWaitRoute[2] && req.method === 'GET') {
          send(res, 200, { ok: true, wait: await options.events.inspect(waitId) });
          return;
        }
        if (eventWaitRoute[2] === 'cancel' && req.method === 'POST') {
          send(res, 200, { ok: true, wait: await options.events.cancel(waitId) });
          return;
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'EVENT_WAIT_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
    }

    if (pathname === '/v1/events/publish' && req.method === 'POST') {
      if (!options.events) {
        send(res, 503, { ok: false, error: { code: 'EVENT_RUNTIME_NOT_CONFIGURED', message: 'Durable event runtime is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const published = await options.events.publish({
          id: String(body.id ?? ''),
          type: String(body.type ?? ''),
          ...(body.correlationKey === undefined ? {} : { correlationKey: String(body.correlationKey) }),
          payloadDigest: String(body.payloadDigest ?? ''),
          occurredAt: String(body.occurredAt ?? '')
        });
        await options.audit?.append({
          ...(body.correlationKey === undefined ? {} : { traceId: String(body.correlationKey) }),
          capability: 'event.publish',
          result: 'success',
          risk: 'write',
          details: {
            eventId: published.event.id,
            eventType: published.event.type,
            satisfiedWaitCount: published.satisfiedWaitIds.length
          }
        });
        send(res, 200, { ok: true, ...published });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'EVENT_PUBLISH_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/events/tick' && req.method === 'POST') {
      if (!options.events) {
        send(res, 503, { ok: false, error: { code: 'EVENT_RUNTIME_NOT_CONFIGURED', message: 'Durable event runtime is not configured.' } });
        return;
      }
      try {
        send(res, 200, { ok: true, ...(await options.events.tick()) });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'EVENT_TICK_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }


    if (pathname === '/v1/migration/checkpoints' && req.method === 'POST') {
      if (!options.semanticMigration) {
        send(res, 503, { ok: false, error: { code: 'SEMANTIC_MIGRATION_NOT_CONFIGURED', message: 'Semantic migration is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        if (body.objective === undefined || body.state === undefined) throw Object.assign(new Error('objective and state are required.'), { code: 'SEMANTIC_MIGRATION_INPUT_INVALID' });
        const requiredCapabilities = Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.map(String) : [];
        const resourceKeys = Array.isArray(body.resourceKeys) ? body.resourceKeys.map(String) : [];
        const supportedCapabilities = await options.runtime.supportedCapabilities(options.permissions.allowedCapabilities);
        const normalizedCapabilities = assertMigrationCapabilities({
          requiredCapabilities,
          permissions: requestPermissions,
          supportedCapabilities
        });
        for (const resourceKey of resourceKeys) {
          if (!await verifyMigrationResourceKey(resourceKey, requestPermissions, normalizedCapabilities)) {
            throw Object.assign(new Error(`Resource ${resourceKey} is not provably authorized on this device.`), { code: 'SEMANTIC_MIGRATION_RESOURCE_MISMATCH' });
          }
        }
        const artifactInputs = Array.isArray(body.artifacts)
          ? body.artifacts.map((item) => {
              const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
              return { key: String(value.key ?? ''), path: String(value.path ?? '') };
            })
          : [];
        const artifacts = await buildMigrationArtifacts(artifactInputs, requestPermissions);
        const assumptionInputs = Array.isArray(body.worldAssumptions)
          ? body.worldAssumptions.map((item) => {
              const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
              return { entityKey: String(value.entityKey ?? ''), factKey: String(value.factKey ?? '') };
            })
          : [];
        if (assumptionInputs.length > 0 && !options.world) {
          throw Object.assign(new Error('World model is required to bind migration assumptions.'), { code: 'WORLD_MODEL_NOT_CONFIGURED' });
        }
        const worldAssumptions = options.world
          ? await buildMigrationWorldAssumptions(assumptionInputs, options.world)
          : [];
        const authorityDigest = migrationAuthorityDigest({
          requiredCapabilities: normalizedCapabilities,
          resourceKeys
        });
        const continuation = body.continuation && typeof body.continuation === 'object' && !Array.isArray(body.continuation)
          ? body.continuation as Record<string, unknown>
          : {};
        const envelope = await options.semanticMigration.create({
          workloadKind: String(body.workloadKind ?? '') as any,
          workloadId: String(body.workloadId ?? ''),
          objectiveDigest: semanticCheckpointDigest(body.objective),
          stateDigest: semanticCheckpointDigest(body.state),
          authorityDigest,
          requiredCapabilities: normalizedCapabilities,
          resourceKeys,
          artifactDigests: artifacts,
          worldAssumptions,
          completedStepDigests: Array.isArray(body.completedStepDigests) ? body.completedStepDigests.map(String) : [],
          continuation,
          ...(body.ttlMs === undefined ? {} : { ttlMs: Number(body.ttlMs) })
        });
        await options.audit?.append({
          capability: 'migration.checkpoint.create',
          result: 'success',
          risk: 'write',
          details: {
            checkpointId: envelope.checkpoint.checkpointId,
            workloadId: envelope.checkpoint.workloadId,
            workloadKind: envelope.checkpoint.workloadKind,
            capabilityCount: envelope.checkpoint.requiredCapabilities.length,
            resourceCount: envelope.checkpoint.resourceKeys.length,
            artifactCount: envelope.checkpoint.artifactDigests.length,
            worldAssumptionCount: envelope.checkpoint.worldAssumptions.length
          }
        });
        send(res, 201, { ok: true, envelope });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SEMANTIC_MIGRATION_CREATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/migration/checkpoints/accept' && req.method === 'POST') {
      if (!options.semanticMigration) {
        send(res, 503, { ok: false, error: { code: 'SEMANTIC_MIGRATION_NOT_CONFIGURED', message: 'Semantic migration is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        if (!body.envelope || typeof body.envelope !== 'object' || Array.isArray(body.envelope)) {
          throw Object.assign(new Error('envelope is required.'), { code: 'SEMANTIC_MIGRATION_INPUT_INVALID' });
        }
        const envelope = body.envelope as SignedSemanticCheckpoint;
        const checkpoint = envelope.checkpoint;
        const requiredCapabilities = Array.isArray(checkpoint?.requiredCapabilities) ? checkpoint.requiredCapabilities.map(String) : [];
        const resourceKeys = Array.isArray(checkpoint?.resourceKeys) ? checkpoint.resourceKeys.map(String) : [];
        const supportedCapabilities = await options.runtime.supportedCapabilities(options.permissions.allowedCapabilities);
        const normalizedCapabilities = assertMigrationCapabilities({
          requiredCapabilities,
          permissions: requestPermissions,
          supportedCapabilities
        });
        const expectedAuthorityDigest = migrationAuthorityDigest({
          requiredCapabilities: normalizedCapabilities,
          resourceKeys
        });
        const resourceMap = body.resourceMap && typeof body.resourceMap === 'object' && !Array.isArray(body.resourceMap)
          ? body.resourceMap as Record<string, unknown>
          : {};
        for (const key of Object.keys(resourceMap)) {
          if (!resourceKeys.includes(key)) {
            throw Object.assign(new Error(`resourceMap contains unknown source resource ${key}.`), { code: 'SEMANTIC_MIGRATION_INPUT_INVALID' });
          }
          if (typeof resourceMap[key] !== 'string' || !resourceMap[key]) {
            throw Object.assign(new Error(`resourceMap value for ${key} must be a non-empty destination resource key.`), { code: 'SEMANTIC_MIGRATION_INPUT_INVALID' });
          }
        }
        const artifactPaths = body.artifactPaths && typeof body.artifactPaths === 'object' && !Array.isArray(body.artifactPaths)
          ? body.artifactPaths as Record<string, unknown>
          : {};
        const accepted = await options.semanticMigration.verifyAndAccept(envelope, {
          expectedAuthorityDigest,
          ...(body.expectedWorkloadId === undefined ? {} : { expectedWorkloadId: String(body.expectedWorkloadId) }),
          ...(body.expectedState === undefined ? {} : { expectedStateDigest: semanticCheckpointDigest(body.expectedState) }),
          availableCapabilities: supportedCapabilities,
          verifyResourceKey: (resourceKey) => {
            const mapped = resourceMap[resourceKey];
            const destinationResource = typeof mapped === 'string' && mapped ? mapped : resourceKey;
            return verifyMigrationResourceKey(destinationResource, requestPermissions, normalizedCapabilities);
          },
          ...(options.world ? {
            verifyWorldAssumption: (assumption) => verifyMigrationWorldAssumption(assumption, options.world!)
          } : {}),
          verifyArtifact: async (artifact) => {
            const mapped = artifactPaths[artifact.key];
            if (typeof mapped !== 'string' || !mapped) return undefined;
            return await hashAuthorizedMigrationArtifact(mapped, requestPermissions);
          }
        });
        await options.audit?.append({
          capability: 'migration.checkpoint.accept',
          result: 'success',
          risk: 'write',
          details: {
            checkpointId: accepted.checkpointId,
            workloadId: accepted.workloadId,
            workloadKind: accepted.workloadKind,
            sourceDeviceId: accepted.sourceDeviceId,
            acceptedForResume: true
          }
        });
        send(res, 200, { ok: true, status: 'accepted-for-resume', checkpoint: accepted });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'SEMANTIC_MIGRATION_ACCEPT_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/studio/teach' && req.method === 'POST') {
      if (!options.teachMode) {
        send(res, 503, { ok: false, error: { code: 'TEACH_MODE_NOT_CONFIGURED', message: 'Teach Mode is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const session = await options.teachMode.start({
          ...(body.sessionId === undefined ? {} : { sessionId: String(body.sessionId) }),
          title: String(body.title ?? ''),
          objective: String(body.objective ?? ''),
          scopeKey: String(body.scopeKey ?? ''),
          ...(body.intent && typeof body.intent === 'object' ? { intent: validIntentBinding(body.intent) } : {})
        });
        send(res, 201, { ok: true, session });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEACH_START_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const teachSessionRoute = /^\/v1\/studio\/teach\/([0-9a-f-]{36})(?:\/(stop|cancel|verify|compile))?$/i.exec(pathname);
    if (teachSessionRoute) {
      if (!options.teachMode) {
        send(res, 503, { ok: false, error: { code: 'TEACH_MODE_NOT_CONFIGURED', message: 'Teach Mode is not configured.' } });
        return;
      }
      try {
        const sessionId = teachSessionRoute[1]!;
        const action = teachSessionRoute[2];
        if (!action && req.method === 'GET') {
          send(res, 200, { ok: true, session: await options.teachMode.inspectSession(sessionId) });
          return;
        }
        if (action === 'stop' && req.method === 'POST') {
          send(res, 200, { ok: true, session: await options.teachMode.stop(sessionId) });
          return;
        }
        if (action === 'cancel' && req.method === 'POST') {
          send(res, 200, { ok: true, session: await options.teachMode.cancel(sessionId) });
          return;
        }
        if (action === 'verify' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          const receipt = await options.teachMode.verify(
            sessionId,
            body.verification ?? (Array.isArray(body.checks) ? body.checks : undefined)
          );
          send(res, 200, { ok: true, receipt });
          return;
        }
        if (action === 'compile' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          const workflow = await options.teachMode.compile(sessionId, {
            verificationReceipt: body.verificationReceipt as any,
            parameters: Array.isArray(body.parameters) ? body.parameters as any : []
          });
          send(res, 200, { ok: true, workflow });
          return;
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEACH_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
    }

    const workflowRoute = /^\/v1\/studio\/workflows\/([0-9a-f-]{36})(?:\/(instantiate|run))?$/i.exec(pathname);
    if (workflowRoute) {
      if (!options.teachMode) {
        send(res, 503, { ok: false, error: { code: 'TEACH_MODE_NOT_CONFIGURED', message: 'Teach Mode is not configured.' } });
        return;
      }
      try {
        if (!workflowRoute[2] && req.method === 'GET') {
          send(res, 200, { ok: true, workflow: await options.teachMode.inspectWorkflow(workflowRoute[1]!) });
          return;
        }
        if (workflowRoute[2] === 'instantiate' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
            ? body.values as Record<string, unknown>
            : {};
          send(res, 200, { ok: true, steps: await options.teachMode.instantiate(workflowRoute[1]!, values) });
          return;
        }
        if (workflowRoute[2] === 'run' && req.method === 'POST') {
          if (!options.studioExecutor) {
            send(res, 503, { ok: false, error: { code: 'STUDIO_EXECUTOR_NOT_CONFIGURED', message: 'Studio workflow execution is not configured.' } });
            return;
          }
          const body = await readJson(req) as Record<string, unknown>;
          const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
            ? body.values as Record<string, unknown>
            : {};
          const run = await options.studioExecutor.submit(
            workflowRoute[1]!,
            values,
            body.runId === undefined ? undefined : String(body.runId),
            body.intent && typeof body.intent === 'object' ? validIntentBinding(body.intent) : undefined
          );
          send(res, 201, { ok: true, run });
          return;
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEACH_WORKFLOW_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
    }

    if (pathname === '/v1/studio/runs' && req.method === 'GET') {
      if (!options.studioExecutor) {
        send(res, 503, { ok: false, error: { code: 'STUDIO_EXECUTOR_NOT_CONFIGURED', message: 'Studio workflow execution is not configured.' } });
        return;
      }
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, runs: await options.studioExecutor.list(limit) });
      return;
    }

    const studioRunRoute = /^\/v1\/studio\/runs\/([0-9a-f-]{36})(?:\/(execute|verify|reconcile|cancel))?$/i.exec(pathname);
    if (studioRunRoute) {
      if (!options.studioExecutor) {
        send(res, 503, { ok: false, error: { code: 'STUDIO_EXECUTOR_NOT_CONFIGURED', message: 'Studio workflow execution is not configured.' } });
        return;
      }
      try {
        const runId = studioRunRoute[1]!;
        const operation = studioRunRoute[2];
        if (!operation && req.method === 'GET') {
          send(res, 200, { ok: true, run: await options.studioExecutor.inspect(runId) });
          return;
        }
        if (operation === 'execute' && req.method === 'POST') {
          if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
            send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Studio execution is frozen by the local emergency stop.' } });
            return;
          }
          const body = await readJson(req) as Record<string, unknown>;
          const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
          const maxSteps = body.maxSteps === undefined ? 1 : Number(body.maxSteps);
          const signal = AbortSignal.timeout(50_000);
          const run = await options.studioExecutor.execute(runId, {
            maxSteps,
            signal,
            executeAction: (action, _permissions, actionSignal) =>
              executeStudioActionWithApproval(action, approvalAuthority, actionSignal)
          });
          send(res, 200, { ok: true, run });
          return;
        }
        if (operation === 'verify' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          const run = await options.studioExecutor.verify(
            runId,
            body.verification ?? (Array.isArray(body.checks) ? body.checks : undefined)
          );
          send(res, 200, { ok: true, run });
          return;
        }
        if (operation === 'reconcile' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          const run = await options.studioExecutor.reconcile(runId, String(body.stepKey ?? ''), {
            resolution: String(body.resolution ?? '') as any,
            checks: Array.isArray(body.checks) ? body.checks as any : []
          });
          send(res, 200, { ok: true, run });
          return;
        }
        if (operation === 'cancel' && req.method === 'POST') {
          send(res, 200, { ok: true, run: await options.studioExecutor.cancel(runId) });
          return;
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'STUDIO_RUN_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
    }

    if (pathname === '/v1/desired-state' && req.method === 'GET') {
      if (!options.desiredState) {
        send(res, 503, { ok: false, error: { code: 'DESIRED_STATE_NOT_CONFIGURED', message: 'Desired-state operations are not configured.' } });
        return;
      }
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, contracts: await options.desiredState.list(limit) });
      return;
    }

    if (pathname === '/v1/desired-state' && req.method === 'POST') {
      if (!options.desiredState) {
        send(res, 503, { ok: false, error: { code: 'DESIRED_STATE_NOT_CONFIGURED', message: 'Desired-state operations are not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const contract = await options.desiredState.create({
          ...(body.contractId === undefined ? {} : { contractId: String(body.contractId) }),
          name: String(body.name ?? ''),
          scopeKey: String(body.scopeKey ?? ''),
          desired: Array.isArray(body.desired) ? body.desired as any : [],
          remediation: body.remediation as any,
          policy: body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy) ? body.policy as any : undefined
        });
        send(res, 201, { ok: true, contract });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'DESIRED_STATE_CREATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const desiredRoute = /^\/v1\/desired-state\/([0-9a-f-]{36})(?:\/(reconcile|pause|resume))?$/i.exec(pathname);
    if (desiredRoute) {
      if (!options.desiredState) {
        send(res, 503, { ok: false, error: { code: 'DESIRED_STATE_NOT_CONFIGURED', message: 'Desired-state operations are not configured.' } });
        return;
      }
      try {
        const id = desiredRoute[1]!;
        const action = desiredRoute[2];
        if (!action && req.method === 'GET') {
          send(res, 200, { ok: true, contract: await options.desiredState.inspect(id) });
          return;
        }
        if (action === 'reconcile' && req.method === 'POST') {
          if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
            send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Desired-state reconciliation is frozen by the local emergency stop.' } });
            return;
          }
          send(res, 200, { ok: true, contract: await options.desiredState.reconcile(id) });
          return;
        }
        if (action === 'pause' && req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          send(res, 200, { ok: true, contract: await options.desiredState.pause(id, { cancelActive: body.cancelActive === true }) });
          return;
        }
        if (action === 'resume' && req.method === 'POST') {
          if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
            send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Desired-state resume is frozen by the local emergency stop.' } });
            return;
          }
          send(res, 200, { ok: true, contract: await options.desiredState.resume(id) });
          return;
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'DESIRED_STATE_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
    }

    if (pathname === '/v1/procedures' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, configured: Boolean(options.procedures), procedures: options.procedures ? await options.procedures.list(limit) : [] });
      return;
    }

    if (pathname === '/v1/procedures/query' && req.method === 'POST') {
      if (!options.procedures) { send(res, 503, { ok: false, error: { code: 'PROCEDURE_MEMORY_NOT_CONFIGURED', message: 'Verified procedure memory is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const candidates = await options.procedures.findReusable({
          objectiveKind: String(body.objectiveKind ?? ''),
          scopeKey: String(body.scopeKey ?? ''),
          assumptions: Array.isArray(body.assumptions) ? body.assumptions as any : [],
          requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.map(String) : [],
          maxResults: body.maxResults === undefined ? undefined : Number(body.maxResults)
        });
        send(res, 200, { ok: true, candidates });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'PROCEDURE_QUERY_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/world/entities' && req.method === 'GET') {
      if (!options.world) { send(res, 503, { ok: false, error: { code: 'WORLD_MODEL_NOT_CONFIGURED', message: 'World model is not configured.' } }); return; }
      try {
        const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 1000) : 100;
        const scopeKey = requestUrl.searchParams.get('scopeKey') ?? undefined;
        const type = requestUrl.searchParams.get('type') ?? undefined;
        send(res, 200, { ok: true, entities: await options.world.listEntities({ ...(scopeKey ? { scopeKey } : {}), ...(type ? { type } : {}), limit }) });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'WORLD_QUERY_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/world/query' && req.method === 'POST') {
      if (!options.world) { send(res, 503, { ok: false, error: { code: 'WORLD_MODEL_NOT_CONFIGURED', message: 'World model is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const operation = String(body.operation ?? '');
        if (operation === 'fact') {
          send(res, 200, { ok: true, fact: await options.world.resolveFact(String(body.entityKey ?? ''), String(body.factKey ?? '')) });
          return;
        }
        if (operation === 'entity') {
          send(res, 200, { ok: true, entity: await options.world.inspectEntity(String(body.entityKey ?? '')) ?? null });
          return;
        }
        if (operation === 'trace') {
          send(res, 200, { ok: true, trace: await options.world.trace({
            fromKey: String(body.fromKey ?? ''),
            ...(body.toKey === undefined ? {} : { toKey: String(body.toKey) }),
            ...(body.targetType === undefined ? {} : { targetType: String(body.targetType) }),
            ...(body.maxDepth === undefined ? {} : { maxDepth: Number(body.maxDepth) }),
            ...(body.minConfidence === undefined ? {} : { minConfidence: Number(body.minConfidence) })
          }) ?? null });
          return;
        }
        if (operation === 'history') {
          send(res, 200, { ok: true, history: await options.world.history({
            entityKey: String(body.entityKey ?? ''),
            ...(body.factKey === undefined ? {} : { factKey: String(body.factKey) }),
            ...(body.source === undefined ? {} : { source: String(body.source) }),
            ...(body.since === undefined ? {} : { since: String(body.since) }),
            ...(body.until === undefined ? {} : { until: String(body.until) }),
            ...(body.limit === undefined ? {} : { limit: Number(body.limit) })
          }) });
          return;
        }
        throw new Error('world query operation must be fact, entity, trace, or history.');
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'WORLD_QUERY_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/device-pool/reservations' && req.method === 'GET') {
      if (!options.devicePool) { send(res, 503, { ok: false, error: { code: 'DEVICE_POOL_NOT_CONFIGURED', message: 'Device pool is not configured.' } }); return; }
      try {
        const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
        const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 1000) : 100;
        const deviceId = requestUrl.searchParams.get('deviceId') ?? undefined;
        send(res, 200, { ok: true, reservations: await options.devicePool.list({ activeOnly: requestUrl.searchParams.get('activeOnly') === '1', ...(deviceId ? { deviceId } : {}), limit }) });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'DEVICE_POOL_QUERY_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/optimizer' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 200);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 1000) : 200;
      send(res, 200, { ok: true, configured: Boolean(options.optimizer), entries: options.optimizer ? await options.optimizer.inspect(limit) : [] });
      return;
    }

    if (pathname === '/v1/organizations' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, configured: Boolean(options.organizations), programs: options.organizations ? await options.organizations.list(limit) : [] });
      return;
    }

    const organizationRoute = /^\/v1\/organizations\/([0-9a-f-]{36})$/i.exec(pathname);
    if (organizationRoute && req.method === 'GET') {
      if (!options.organizations) { send(res, 503, { ok: false, error: { code: 'ORGANIZATION_NOT_CONFIGURED', message: 'Organization coordinator is not configured.' } }); return; }
      try { send(res, 200, { ok: true, program: await options.organizations.inspect(organizationRoute[1]!) }); }
      catch (error) { send(res, 404, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'ORGANIZATION_PROGRAM_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } }); }
      return;
    }

    if (pathname === '/v1/operations' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, configured: Boolean(options.operations), operations: options.operations ? await options.operations.list(limit) : [] });
      return;
    }

    if (pathname === '/v1/operations' && req.method === 'POST') {
      if (!options.operations) { send(res, 503, { ok: false, error: { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Digital operations layer is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        if (body.device !== undefined) throw new Error('Device advertisements are relay-authority data and cannot be supplied through the local agent operation API.');
        if (body.run === true && options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Digital operation execution is frozen by the local emergency stop.' } });
          return;
        }
        const operation = await options.operations.submit(body as unknown as DigitalOperationSubmit);
        send(res, body.run === true ? 200 : 202, { ok: true, operation });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'OPERATIONS_SUBMISSION_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const operationRoute = /^\/v1\/operations\/([0-9a-f-]{36})(?:\/(start|refresh|pause|cancel|promote))?$/i.exec(pathname);
    if (operationRoute && req.method === 'GET' && !operationRoute[2]) {
      if (!options.operations) { send(res, 503, { ok: false, error: { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Digital operations layer is not configured.' } }); return; }
      try { send(res, 200, { ok: true, operation: await options.operations.inspect(operationRoute[1]!) }); }
      catch (error) { send(res, 404, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'OPERATIONS_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } }); }
      return;
    }
    if (operationRoute && req.method === 'POST' && operationRoute[2]) {
      if (!options.operations) { send(res, 503, { ok: false, error: { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Digital operations layer is not configured.' } }); return; }
      try {
        const id = operationRoute[1]!;
        const op = operationRoute[2]!;
        const body = await readJson(req) as Record<string, unknown>;
        if ((op === 'start' || op === 'refresh' || op === 'promote')
          && options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Digital operation advancement is frozen by the local emergency stop.' } });
          return;
        }
        const operation = op === 'start' ? await options.operations.start(id)
          : op === 'refresh' ? await options.operations.refresh(id)
          : op === 'pause' ? await options.operations.pause(id)
          : op === 'cancel' ? await options.operations.cancel(id)
          : await options.operations.promoteOrganization(id, String(body.verificationDigest ?? ''));
        send(res, 200, { ok: true, operation });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'OPERATIONS_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/teams' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, teams: options.teams ? await options.teams.list(limit) : [], configured: Boolean(options.teams) });
      return;
    }

    if (pathname === '/v1/teams' && req.method === 'POST') {
      if (!options.teams) {
        send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const mission = await options.teams.submit({
          objective: body.objective as string,
          workItems: body.workItems as TeamWorkInput[],
          budget: body.budget as any,
          ...(body.intent && typeof body.intent === 'object' ? { intent: validIntentBinding(body.intent) } : {})
        });
        const result = body.run === true ? await options.teams.start(mission.id) : mission;
        send(res, body.run === true ? 200 : 202, { ok: true, mission: result });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_SUBMISSION_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const teamRoute = /^\/v1\/teams\/([0-9a-f-]{36})(?:\/(start|pause|resume|cancel|claim))?$/i.exec(pathname);
    if (teamRoute && req.method === 'GET' && !teamRoute[2]) {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try { send(res, 200, { ok: true, mission: await options.teams.inspect(teamRoute[1]!) }); }
      catch (error) { send(res, 404, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } }); }
      return;
    }
    if (teamRoute && req.method === 'POST' && teamRoute[2]) {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const id = teamRoute[1]!;
        const operation = teamRoute[2]!;
        const body = await readJson(req) as Record<string, unknown>;
        if ((operation === 'start' || operation === 'resume' || operation === 'claim')
          && options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Team orchestration is frozen by the local emergency stop.' } });
          return;
        }
        if (operation === 'claim') {
          const result = await options.teams.claim(id, { workerId: String(body.workerId ?? '') });
          send(res, 200, { ok: true, mission: result.mission, ...(result.workItem ? { workItem: result.workItem } : {}) });
          return;
        }
        const mission = operation === 'start' ? await options.teams.start(id)
          : operation === 'pause' ? await options.teams.pause(id)
          : operation === 'resume' ? await options.teams.resume(id)
          : await options.teams.cancel(id);
        if (operation === 'pause' || operation === 'cancel') abortTeamActions((entry) => entry.missionId === id);
        send(res, 200, { ok: true, mission });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const workerRegisterRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/workers\/register$/i.exec(pathname);
    if (workerRegisterRoute && req.method === 'POST') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const result = await options.teams.registerWorker(workerRegisterRoute[1]!, {
          ...(body.workerId === undefined ? {} : { workerId: String(body.workerId) }),
          role: body.role as TeamRole,
          label: String(body.label ?? ''),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : []
        });
        send(res, 200, { ok: true, mission: result.mission, worker: result.worker });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_WORKER_INVALID', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const workerActionRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/workers\/([0-9a-f-]{36})\/(heartbeat|revoke)$/i.exec(pathname);
    if (workerActionRoute && req.method === 'POST') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const mission = workerActionRoute[3] === 'heartbeat'
          ? await options.teams.heartbeat(workerActionRoute[1]!, { workerId: workerActionRoute[2]!, ...(body.leaseId === undefined ? {} : { leaseId: String(body.leaseId) }) })
          : await options.teams.revokeWorker(workerActionRoute[1]!, { workerId: workerActionRoute[2]! });
        if (workerActionRoute[3] === 'revoke') {
          abortTeamActions((entry) => entry.missionId === workerActionRoute[1]! && entry.workerId === workerActionRoute[2]!);
        }
        send(res, 200, { ok: true, mission });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_WORKER_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const teamBlackboardRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/blackboard$/i.exec(pathname);
    if (teamBlackboardRoute && req.method === 'GET') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const mission = await options.teams.inspect(teamBlackboardRoute[1]!);
        send(res, 200, { ok: true, blackboard: mission.blackboard, missionState: mission.state, updatedAt: mission.updatedAt });
      } catch (error) {
        send(res, 404, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_NOT_FOUND', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }
    if (teamBlackboardRoute && req.method === 'POST') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const mission = await options.teams.putBlackboard(teamBlackboardRoute[1]!, {
          workerId: String(body.workerId ?? ''),
          key: String(body.key ?? ''),
          value: body.value,
          ...(body.expectedRevision === undefined ? {} : { expectedRevision: Number(body.expectedRevision) }),
          ...(body.workItemId === undefined ? {} : { workItemId: String(body.workItemId) }),
          ...(body.leaseId === undefined ? {} : { leaseId: String(body.leaseId) })
        });
        send(res, 200, { ok: true, mission, blackboard: mission.blackboard });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_BLACKBOARD_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const teamExecuteRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/work\/([0-9a-f-]{36})\/execute$/i.exec(pathname);
    if (teamExecuteRoute && req.method === 'POST') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Operator execution is disabled by the local emergency stop.' } });
          return;
        }
        const body = await readJson(req) as Record<string, unknown>;
        const workerId = String(body.workerId ?? '');
        const leaseId = String(body.leaseId ?? '');
        const action = validateActionEnvelope(body.action);
        const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
        const resourceKeys = resourceKeysForAction(action);
        const authorization = await options.teams.authorizeExecution(teamExecuteRoute[1]!, {
          workerId,
          workItemId: teamExecuteRoute[2]!,
          leaseId,
          capability: action.capability,
          risk: action.risk,
          resourceKeys
        });
        const ownedLease = authorization.workItem.lease;
        if (!ownedLease) throw new Error('Authorized team work lost its lease before execution.');
        const remainingLeaseMs = Math.max(1, Date.parse(ownedLease.expiresAt) - Date.now());
        const { intent: _workerIntent, ...actionWithoutIntent } = action;
        const teamAction: ActionRequest = {
          ...actionWithoutIntent,
          taskId: teamExecuteRoute[1]!,
          ...(authorization.mission.intent ? { intent: authorization.mission.intent } : {})
        };
        const receipt = await options.teams.beginActionExecution(teamExecuteRoute[1]!, {
          workerId, workItemId: teamExecuteRoute[2]!, leaseId, action: teamAction
        });
        if (receipt.status === 'completed') {
          send(res, receipt.result.ok ? 200 : 409, receipt.result);
          return;
        }
        const controller = new AbortController();
        const actionKey = [teamExecuteRoute[1]!, teamExecuteRoute[2]!, leaseId, action.id].join(':');
        activeTeamActions.set(actionKey, { missionId: teamExecuteRoute[1]!, workItemId: teamExecuteRoute[2]!, workerId, controller });
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remainingLeaseMs)]);
        let result: ActionResult;
        let autoResumedAfterApproval = false;
        try {
          result = await executeActionWithCurrentApproval(teamAction, approvalAuthority, signal);
        if (result.provider === 'policy' && result.error?.code === 'APPROVAL_REQUIRED' && options.approvals) {
          const pending = await options.approvals.register(teamAction, approvalAuthority);
          const decision = options.recoveryToken ? await waitForApprovalDecision(teamAction.id, pending.approvalRequestId) : null;
          if (decision === 'approve' || decision === 'session') {
            await options.teams.authorizeExecution(teamExecuteRoute[1]!, {
              workerId,
              workItemId: teamExecuteRoute[2]!,
              leaseId,
              capability: teamAction.capability,
              risk: teamAction.risk,
              resourceKeys
            });
            result = await executeActionWithCurrentApproval(teamAction, approvalAuthority, signal);
            autoResumedAfterApproval = true;
          } else if (decision === 'deny') {
            result = {
              ok: false, capability: teamAction.capability, provider: 'policy', evidence: [{
                kind: 'approval', status: 'fail', message: 'The local user denied this Stage-4 worker action.', timestamp: new Date().toISOString()
              }],
              error: { code: 'APPROVAL_DENIED', message: 'The local user denied this Stage-4 worker action.', retryable: false },
              durationMs: result.durationMs
            };
          }
        }
        result = await options.teams.completeActionExecution(teamExecuteRoute[1]!, {
          workerId, workItemId: teamExecuteRoute[2]!, leaseId, action: teamAction, result
        });
        try {
          await options.audit?.append({
          traceId: teamExecuteRoute[1]!,
          missionId: teamExecuteRoute[1]!,
          workItemId: teamExecuteRoute[2]!,
          workerId,
          actionId: teamAction.id,
          providerId: result.provider,
          capability: teamAction.capability,
          target: teamAction.target,
          result: result.ok ? 'success' : result.provider === 'policy' ? 'blocked' : 'failure',
          risk: teamAction.risk,
          details: {
            durationMs: result.durationMs,
            errorCode: result.error?.code,
            sideEffectState: result.error?.sideEffectState,
            teamLeaseId: leaseId,
            autoResumedAfterApproval
          }
          });
        } catch (error) {
          const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'AUDIT_APPEND_FAILED';
          result = await options.teams.recordActionAuditFailure(teamExecuteRoute[1]!, teamAction.id, result, code);
        }
        send(res, result.ok ? 200 : 409, result);
        } finally {
          activeTeamActions.delete(actionKey);
        }
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const worldPublishRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/work\/([0-9a-f-]{36})\/world-publish$/i.exec(pathname);
    if (worldPublishRoute && req.method === 'POST') {
      if (!options.teams || !options.world) {
        send(res, 503, { ok: false, error: { code: 'WORLD_PUBLICATION_NOT_CONFIGURED', message: 'Team/world integration is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const missionId = worldPublishRoute[1]!;
        const workItemId = worldPublishRoute[2]!;
        const mission = await options.teams.inspect(missionId);
        const item = mission.workItems.find((candidate) => candidate.id === workItemId);
        if (!item || item.role !== 'verifier' || item.state !== 'COMPLETED' || item.result?.verificationPassed !== true
          || typeof item.result.verificationDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(item.result.verificationDigest)
          || !item.result.worldObservationDigest) {
          throw Object.assign(new Error('Completed verifier world-observation commitment is required.'), { code: 'TEAM_WORLD_OBSERVATION_DENIED' });
        }
        const prepared = prepareVerifierWorldObservations(body.worldObservations, missionId, workItemId);
        if (prepared.digest !== item.result.worldObservationDigest) {
          throw Object.assign(new Error('World observation payload does not match the verifier commitment.'), { code: 'TEAM_WORLD_OBSERVATION_COMMITMENT_MISMATCH' });
        }
        const published = await publishVerifierWorldObservations(options.world, mission, item, prepared.observations);
        send(res, 200, { ok: true, mission, worldObservationsPublished: published });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_WORLD_PUBLICATION_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const workRoute = /^\/v1\/teams\/([0-9a-f-]{36})\/work\/([0-9a-f-]{36})\/(complete|fail|reconcile)$/i.exec(pathname);
    if (workRoute && req.method === 'POST') {
      if (!options.teams) { send(res, 503, { ok: false, error: { code: 'TEAM_COORDINATOR_NOT_CONFIGURED', message: 'Stage-4 team coordination is not configured.' } }); return; }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const id = workRoute[1]!;
        const workItemId = workRoute[2]!;
        const operation = workRoute[3]!;
        if (operation === 'complete') {
          let preparedWorld: ReturnType<typeof prepareVerifierWorldObservations> | undefined;
          if (body.worldObservations !== undefined) {
            if (!options.world) throw Object.assign(new Error('World model is not configured.'), { code: 'WORLD_MODEL_NOT_CONFIGURED' });
            const before = await options.teams.inspect(id);
            const item = before.workItems.find((candidate) => candidate.id === workItemId);
            if (!item || item.role !== 'verifier') {
              throw Object.assign(new Error('Only a passing verifier may commit world observations.'), { code: 'TEAM_WORLD_OBSERVATION_DENIED' });
            }
            preparedWorld = prepareVerifierWorldObservations(body.worldObservations, id, workItemId);
          }
          const mission = await options.teams.complete(id, {
            workerId: String(body.workerId ?? ''), workItemId, leaseId: String(body.leaseId ?? ''),
            summary: String(body.summary ?? ''), evidence: Array.isArray(body.evidence) ? body.evidence as any : [],
            verificationPassed: body.verificationPassed === true,
            ...(body.verification !== undefined ? { verification: body.verification } : {}),
            ...(preparedWorld ? { worldObservationDigest: preparedWorld.digest } : {})
          });
          let worldObservationsPublished = 0;
          let worldObservationWarning: { code: string; message: string } | undefined;
          if (preparedWorld && options.world) {
            const completed = mission.workItems.find((candidate) => candidate.id === workItemId)!;
            try {
              worldObservationsPublished = await publishVerifierWorldObservations(options.world, mission, completed, preparedWorld.observations);
            } catch (error) {
              worldObservationWarning = {
                code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_WORLD_PUBLICATION_FAILED',
                message: error instanceof Error ? error.message : String(error)
              };
            }
          }
          send(res, 200, {
            ok: true, mission,
            ...(preparedWorld ? { worldObservationsPublished } : {}),
            ...(worldObservationWarning ? { worldObservationWarning } : {})
          });
          return;
        }

        const mission = operation === 'fail'
          ? await options.teams.fail(id, {
              workerId: String(body.workerId ?? ''), workItemId, leaseId: String(body.leaseId ?? ''),
              code: String(body.code ?? ''), message: String(body.message ?? ''),
              sideEffectState: body.sideEffectState as 'none' | 'known' | 'uncertain',
              retryable: body.retryable === true
            })
          : await options.teams.reconcile(id, {
              workerId: String(body.workerId ?? ''), workItemId,
              resolution: body.resolution as 'completed' | 'retry' | 'failed',
              summary: String(body.summary ?? ''), evidence: Array.isArray(body.evidence) ? body.evidence as any : []
            });
        send(res, 200, { ok: true, mission });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TEAM_WORK_CONTROL_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/tasks' && req.method === 'GET') {
      const requested = Number(requestUrl.searchParams.get('limit') ?? 100);
      const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      send(res, 200, { ok: true, tasks: options.tasks ? await options.tasks.list(limit) : [], configured: Boolean(options.tasks) });
      return;
    }

    if (pathname === '/v1/tasks' && req.method === 'POST') {
      if (!options.taskOrchestrator) {
        send(res, 503, { ok: false, error: { code: 'TASK_EXECUTOR_NOT_CONFIGURED', message: 'Task execution is not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as Record<string, unknown>;
        const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
        assertEnterpriseApprovalBinding(relayRequest, requestEnterpriseContext, approvalAuthority);
        const goal = body.goal as SemanticTaskGoal;
        const authorizedScope = taskAuthorizedScope(goal, requestPermissions.allowedRoots);
        if (!authorizedScope) {
          send(res, 403, { ok: false, error: { code: 'TASK_SCOPE_DENIED', message: 'Task goal root is outside the authorized roots.' } });
          return;
        }
        if (body.run === true && options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Operator task execution is disabled by the local emergency stop.' } });
          return;
        }
        const submitted = await options.taskOrchestrator.submit({
          requestId: body.requestId,
          objective: body.objective,
          authorizedScope,
          prohibitedScope: Array.isArray(body.prohibitedScope) ? body.prohibitedScope : [],
          successConditions: body.successConditions,
          goal,
          maxSteps: body.maxSteps,
          maxAttemptsPerStep: body.maxAttemptsPerStep,
          timeoutMs: body.timeoutMs,
          ...(body.intent && typeof body.intent === 'object' ? { intent: body.intent } : {})
        } as SubmitTaskOptions);
        if (body.run === true && relayRequest) {
          const authorization = taskAuthorization(approvalAuthority, requestPermissions);
          void options.taskOrchestrator.run(submitted.id, [], authorization).catch(async (error) => {
            try {
              await options.audit?.append({
                traceId: submitted.id,
                taskId: submitted.id,
                capability: 'task.background.run',
                result: 'failure',
                risk: 'read',
                details: {
                  code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TASK_BACKGROUND_RUN_FAILED'
                }
              });
            } catch { /* task state remains the source of truth */ }
          });
          send(res, 202, { ok: true, task: submitted, accepted: true, executionStarted: true });
          return;
        }
        const task = body.run === true ? await options.taskOrchestrator.run(submitted.id, [], taskAuthorization(approvalAuthority, requestPermissions)) : submitted;
        send(res, body.run === true ? 200 : 202, { ok: true, task });
      } catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'TASK_SUBMISSION_INVALID';
        send(res, 400, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    const taskRoute = /^\/v1\/tasks\/([0-9a-f-]{36})(?:\/(run|pause|resume|cancel))?$/i.exec(pathname);
    if (taskRoute && req.method === 'GET' && !taskRoute[2]) {
      if (!options.tasks) {
        send(res, 503, { ok: false, error: { code: 'TASK_STORE_NOT_CONFIGURED', message: 'Task state is not configured.' } });
        return;
      }
      try { send(res, 200, { ok: true, task: await options.tasks.get(taskRoute[1]!) }); }
      catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'TASK_READ_FAILED';
        send(res, code === 'TASK_NOT_FOUND' ? 404 : 409, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (taskRoute && req.method === 'POST' && taskRoute[2]) {
      if (!options.taskOrchestrator) {
        send(res, 503, { ok: false, error: { code: 'TASK_EXECUTOR_NOT_CONFIGURED', message: 'Task execution is not configured.' } });
        return;
      }
      try {
        const taskId = taskRoute[1]!;
        const operation = taskRoute[2]!;
        const body = await readJson(req) as { approvedActionId?: unknown; approvalAuthority?: unknown };
        const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
        assertEnterpriseApprovalBinding(relayRequest, requestEnterpriseContext, approvalAuthority);
        if ((operation === 'run' || operation === 'resume') && options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Operator task execution is disabled by the local emergency stop.' } });
          return;
        }
        let task;
        if (operation === 'run') task = await options.taskOrchestrator.run(taskId, [], taskAuthorization(approvalAuthority, requestPermissions));
        else if (operation === 'pause') task = await options.taskOrchestrator.pause(taskId);
        else if (operation === 'cancel') task = await options.taskOrchestrator.cancel(taskId);
        else {
          const approvedActionId = body.approvedActionId === undefined ? undefined : boundedString(body.approvedActionId, 'approvedActionId', 256);
          if (approvedActionId) {
            if (!options.recoveryToken) {
              send(res, 503, { ok: false, error: { code: 'TASK_APPROVAL_NOT_CONFIGURED', message: 'Task approval requires a separate recovery token.' } });
              return;
            }
            const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
            if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
              send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
              return;
            }
            const current = options.tasks ? await options.tasks.get(taskId) : null;
            const blocked = current?.execution?.records.find((record) => record.state === 'BLOCKED');
            if (!blocked || blocked.actionId !== approvedActionId) {
              send(res, 409, { ok: false, error: { code: 'TASK_APPROVAL_MISMATCH', message: 'Approval must match the task current blocked action.' } });
              return;
            }
          }
          task = await options.taskOrchestrator.resume(taskId, approvedActionId ? [approvedActionId] : [], taskAuthorization(approvalAuthority, requestPermissions));
        }
        send(res, 200, { ok: true, task });
      } catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'TASK_CONTROL_FAILED';
        send(res, 409, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/devices' && req.method === 'GET') {
      const local = options.deviceIdentity ? await options.deviceIdentity.loadExisting() : null;
      const peers = options.deviceRegistry ? await options.deviceRegistry.listDevices() : [];
      send(res, 200, {
        ok: true,
        local: local ? {
          deviceId: local.deviceId,
          deviceName: local.deviceName,
          createdAt: local.createdAt,
          fingerprint: local.fingerprint
        } : null,
        peers: peers.map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          fingerprint: device.fingerprint,
          status: device.status,
          pairedAt: device.pairedAt,
          revokedAt: device.revokedAt
        })),
        configured: Boolean(options.deviceIdentity)
      });
      return;
    }

    if (pathname === '/v1/settings' && req.method === 'GET') {
      const runtimeStatus = options.getRuntimeStatus ? await options.getRuntimeStatus() : {};
      send(res, 200, { ok: true, settings: { ...(options.settings ?? {}) }, runtime: runtimeStatus });
      return;
    }

    if (pathname === '/v1/privacy' && req.method === 'GET') {
      send(res, 200, { ok: true, categories: options.privacy ? await options.privacy.inventory() : [], configured: Boolean(options.privacy) });
      return;
    }

    if (pathname.startsWith('/v1/privacy/') && req.method === 'DELETE') {
      if (!options.privacy || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'PRIVACY_CONTROLS_NOT_CONFIGURED', message: 'Privacy deletion requires local privacy state and a separate recovery token.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      const category = decodeURIComponent(pathname.slice('/v1/privacy/'.length));
      if (!['activity', 'tasks', 'session-state'].includes(category)) {
        send(res, 400, { ok: false, error: { code: 'PRIVACY_CATEGORY_INVALID', message: 'Only activity, tasks, and session-state can be deleted through the generic privacy API.' } });
        return;
      }
      try {
        const removed = await options.privacy.purge(category as PrivacyCategory);
        send(res, 200, { ok: true, removed, categories: await options.privacy.inventory() });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: 'PRIVACY_PURGE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/device/reset' && req.method === 'POST') {
      if (!options.deviceReset || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'DEVICE_RESET_NOT_CONFIGURED', message: 'Device reset requires local recovery authority.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      try {
        const reset = await options.deviceReset();
        options.sessionApprovals?.clear();
        send(res, 200, { ok: true, reset });
      } catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'DEVICE_RESET_FAILED';
        send(res, 409, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/permissions' && req.method === 'GET') {
      send(res, 200, {
        ok: true,
        permissions: {
          allowedCapabilities: [...options.permissions.allowedCapabilities],
          allowedRoots: [...options.permissions.allowedRoots],
          allowExternalWrites: Boolean(options.permissions.allowExternalWrites),
          allowSystemChanges: Boolean(options.permissions.allowSystemChanges),
          allowDestructive: Boolean(options.permissions.allowDestructive),
          approvedActionIds: [...(options.permissions.approvedActionIds ?? [])]
        }
      });
      return;
    }


    if (pathname === '/v1/session-approval' && req.method === 'GET') {
      send(res, 200, { ok: true, session: options.sessionApprovals?.summary() ?? { active: false }, configured: Boolean(options.sessionApprovals) });
      return;
    }

    if (pathname === '/v1/session-approval' && req.method === 'DELETE') {
      if (!options.sessionApprovals || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'SESSION_APPROVAL_NOT_CONFIGURED', message: 'Session approval revocation requires local recovery authority.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      options.sessionApprovals.clear();
      send(res, 200, { ok: true, session: { active: false } });
      return;
    }

    if (pathname === '/v1/approvals' && req.method === 'GET') {
      if (!options.approvals) {
        send(res, 200, { ok: true, approvals: [], configured: false });
        return;
      }
      const approvals = (await options.approvals.list()).map((record) => ({
        actionId: record.actionId,
        capability: record.capability,
        risk: record.risk,
        target: record.target,
        status: record.status,
        createdAt: record.createdAt,
        pendingExpiresAt: record.pendingExpiresAt,
        approvalRequestId: record.approvalRequestId,
        approvalExpiresAt: record.approvalExpiresAt
      }));
      send(res, 200, { ok: true, approvals, session: options.sessionApprovals?.summary() ?? { active: false }, configured: true });
      return;
    }

    if (pathname.startsWith('/v1/approvals/') && req.method === 'POST') {
      if (!options.approvals || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'APPROVALS_NOT_CONFIGURED', message: 'One-time approvals require persistent approval state and a recovery token.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      try {
        const actionId = boundedString(decodeURIComponent(pathname.slice('/v1/approvals/'.length)), 'actionId', 256);
        const body = await readJson(req) as { decision?: unknown; approvalRequestId?: unknown };
        const decision = String(body.decision ?? '');
        const approvalRequestId = boundedString(body.approvalRequestId, 'approvalRequestId', 128);
        if (decision === 'session' && !options.sessionApprovals) {
          send(res, 503, { ok: false, error: { code: 'SESSION_APPROVAL_NOT_CONFIGURED', message: 'Session approvals are not configured.' } });
          return;
        }
        const record = decision === 'approve' || decision === 'session'
          ? await options.approvals.approve(actionId, approvalRequestId)
          : decision === 'deny'
            ? await options.approvals.deny(actionId, approvalRequestId)
            : null;
        const session = decision === 'session'
          ? options.sessionApprovals?.grant(record!, options.permissions)
          : undefined;
        if (!record) {
          send(res, 400, { ok: false, error: { code: 'APPROVAL_DECISION_INVALID', message: 'decision must be approve, session, or deny.' } });
          return;
        }
        const notifiedWaiters = notifyApprovalDecision(actionId, approvalRequestId, decision as InlineApprovalDecision);
        if ((decision === 'approve' || decision === 'session')
          && notifiedWaiters === 0
          && record.continuationTaskId
          && options.taskOrchestrator
          && options.tasks) {
          const continuation = await options.tasks.get(record.continuationTaskId).catch(() => null);
          const blocked = continuation?.execution?.records.find((item) => item.state === 'BLOCKED' && item.actionId === actionId);
          if (continuation?.state === 'BLOCKED' && blocked) {
            void options.taskOrchestrator.resume(
              record.continuationTaskId,
              [],
              taskAuthorization(undefined, options.permissions)
            ).catch(async (error) => {
              try {
                await options.audit?.append({
                  traceId: record.continuationTaskId,
                  taskId: record.continuationTaskId,
                  actionId,
                  capability: 'task.approval.continuation',
                  result: 'failure',
                  risk: 'read',
                  details: { code: typeof (error as any)?.code === 'string' ? (error as any).code : 'TASK_APPROVAL_CONTINUATION_FAILED' }
                });
              } catch { /* blocked task remains durable and explicitly resumable */ }
            });
          }
        }
        send(res, 200, {
          ok: true,
          approval: {
            actionId: record.actionId,
            capability: record.capability,
            risk: record.risk,
            target: record.target,
            status: record.status,
            approvalRequestId: record.approvalRequestId,
            approvalExpiresAt: record.approvalExpiresAt
          },
          ...(session ? { session: { active: true, id: session.id, expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt } } : {})
        });
      } catch (error) {
        send(res, 409, { ok: false, error: { code: 'APPROVAL_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'GET') {
      if (!options.emergencyStop) {
        send(res, 200, { ok: true, state: { version: 1, engaged: false }, configured: false });
        return;
      }
      send(res, 200, { ok: true, state: await options.emergencyStop.status(), configured: true });
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'POST') {
      if (!options.emergencyStop || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'EMERGENCY_STOP_NOT_CONFIGURED', message: 'Emergency stop requires persistent state and a separate recovery token before it can be engaged.' } });
        return;
      }
      try {
        const body = await readJson(req) as { reason?: unknown };
        const reason = body.reason === undefined ? undefined : String(body.reason);
        const state = await options.emergencyStop.engage(reason);
        const aborted = abortEmergencyExecutions();
        options.sessionApprovals?.clear();
        if (options.teams && aborted.teamActions.length > 0) {
          const missionIds = [...new Set(aborted.teamActions.map((entry) => entry.missionId))].sort();
          await Promise.allSettled(missionIds.map((missionId) => options.teams!.pause(missionId)));
        }
        await options.onEmergencyStop?.();
        await options.audit?.append({
          capability: 'agent.emergency-stop',
          result: 'success',
          risk: 'destructive',
          details: {
            operation: 'engage',
            abortedTaskCount: aborted.taskIds.length,
            abortedTeamActionCount: aborted.teamActions.length
          }
        });
        send(res, 200, { ok: true, state });
      } catch (error) {
        send(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (pathname === '/v1/emergency-stop' && req.method === 'DELETE') {
      if (!options.emergencyStop || !options.recoveryToken) {
        send(res, 503, { ok: false, error: { code: 'EMERGENCY_STOP_NOT_CONFIGURED', message: 'Emergency stop recovery is not configured.' } });
        return;
      }
      const supplied = Array.isArray(req.headers['x-operator-recovery-token']) ? req.headers['x-operator-recovery-token'][0] : req.headers['x-operator-recovery-token'];
      if (!timingSafeSecretMatch(supplied, options.recoveryToken)) {
        send(res, 401, { ok: false, error: { code: 'RECOVERY_UNAUTHORIZED', message: 'Valid recovery token required.' } });
        return;
      }
      const state = await options.emergencyStop.clear();
      resetEmergencyExecutionGeneration();
      try {
        await options.onEmergencyClear?.();
      } catch (error) {
        await options.emergencyStop.engage('emergency recovery callback failed');
        abortEmergencyExecutions();
        options.sessionApprovals?.clear();
        await options.onEmergencyStop?.();
        send(res, 503, { ok: false, error: { code: 'EMERGENCY_CLEAR_FAILED', message: error instanceof Error ? error.message : String(error) } });
        return;
      }
      await options.audit?.append({
        capability: 'agent.emergency-stop',
        result: 'success',
        risk: 'destructive',
        details: { operation: 'clear' }
      });
      send(res, 200, { ok: true, state });
      return;
    }

    if (pathname === '/v1/action-receipt' && req.method === 'POST') {
      if (!options.actionExecutions) {
        send(res, 404, { ok: false, error: { code: 'ACTION_EXECUTION_RECEIPTS_DISABLED', message: 'Local action execution receipts are not configured.' } });
        return;
      }
      try {
        const body = await readJson(req) as { action?: ActionRequest; approvalAuthority?: unknown };
        if (!body.action || typeof body.action !== 'object') {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'action is required.' } });
          return;
        }
        const action = validateActionEnvelope(body.action);
        const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
        assertEnterpriseApprovalBinding(relayRequest, requestEnterpriseContext, approvalAuthority);
        let receipt = await options.actionExecutions.lookup(action, approvalAuthority);
        if (options.agentKernel && receipt.status !== 'missing') {
          receipt = await options.actionExecutions.reconcileWithKernel(action, approvalAuthority, options.agentKernel.journal);
        }
        if (receipt.status === 'missing') {
          send(res, 404, { ok: false, error: { code: 'ACTION_EXECUTION_RECEIPT_NOT_FOUND', message: 'No durable execution receipt exists for this exact action.' } });
          return;
        }
        if (receipt.status === 'processing') {
          send(res, 202, {
            ok: true,
            receipt: {
              status: 'processing',
              actionId: receipt.record.actionId,
              startedAt: receipt.record.startedAt
            }
          });
          return;
        }
        send(res, 200, {
          ok: true,
          receipt: {
            status: 'completed',
            actionId: receipt.record.actionId,
            startedAt: receipt.record.startedAt,
            completedAt: receipt.record.completedAt,
            resultSha256: receipt.record.resultSha256
          },
          result: receipt.result
        });
      } catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'BAD_REQUEST';
        send(res, code.startsWith('ACTION_EXECUTION_') ? 409 : 400, {
          ok: false,
          error: { code, message: error instanceof Error ? error.message : String(error) }
        });
      }
      return;
    }

    if (pathname === '/v1/execute' && req.method === 'POST') {
      try {
        if (options.emergencyStop && (await options.emergencyStop.status()).engaged) {
          await options.audit?.append({
            capability: 'agent.execute',
            result: 'blocked',
            risk: 'system',
            details: { code: 'EMERGENCY_STOPPED' }
          });
          send(res, 423, { ok: false, error: { code: 'EMERGENCY_STOPPED', message: 'Operator execution is disabled by the local emergency stop.' } });
          return;
        }
        const body = await readJson(req) as { action?: ActionRequest; approvalAuthority?: unknown; teachSessionId?: unknown };
        if (!body.action || typeof body.action !== 'object') {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'action is required.' } });
          return;
        }
        const action = validateActionEnvelope(body.action);
        const approvalAuthority = body.approvalAuthority === undefined ? undefined : validateApprovalAuthority(body.approvalAuthority);
        assertEnterpriseApprovalBinding(relayRequest, requestEnterpriseContext, approvalAuthority);
        if (options.actionExecutions) {
          let receipt = await options.actionExecutions.begin(action, approvalAuthority);
          if (options.agentKernel && receipt.status !== 'started') {
            const reconciled = await options.actionExecutions.reconcileWithKernel(action, approvalAuthority, options.agentKernel.journal);
            if (reconciled.status === 'missing') {
              throw new OperatorError('ACTION_EXECUTION_RECONCILIATION_REQUIRED', 'Local action execution receipt disappeared during kernel reconciliation.', { retryable: false });
            }
            receipt = reconciled;
          }
          if (receipt.status === 'completed') {
            send(res, receipt.result.ok ? 200 : 409, receipt.result);
            return;
          }
          if (receipt.status === 'processing') {
            send(res, 409, {
              ok: false,
              error: {
                code: 'ACTION_EXECUTION_IN_PROGRESS',
                message: 'This exact action already has an unfinished durable execution receipt; it will not be replayed blindly.',
                retryable: true,
                sideEffectState: 'uncertain'
              },
              receipt: { actionId: receipt.record.actionId, startedAt: receipt.record.startedAt }
            });
            return;
          }
        }
        let result = await executeActionWithCurrentApproval(action, approvalAuthority, undefined, requestPermissions);
        let autoResumedAfterApproval = false;
        if (result.provider === 'policy' && result.error?.code === 'APPROVAL_REQUIRED' && options.approvals) {
          const pending = await options.approvals.register(action, approvalAuthority);
          const decision = options.recoveryToken
            ? await waitForApprovalDecision(action.id, pending.approvalRequestId)
            : null;
          if (decision === 'deny') {
            result = {
              ok: false,
              capability: action.capability,
              provider: 'policy',
              evidence: [{
                kind: 'approval',
                status: 'fail',
                message: 'The local user denied this action.',
                timestamp: new Date().toISOString()
              }],
              error: {
                code: 'APPROVAL_DENIED',
                message: 'The local user denied this action.',
                retryable: false
              },
              durationMs: result.durationMs
            };
          } else if (decision === 'approve' || decision === 'session') {
            result = await executeActionWithCurrentApproval(action, approvalAuthority, undefined, requestPermissions);
            autoResumedAfterApproval = true;
          }
        }
        let teachCaptured = false;
        let teachCaptureCode: string | undefined;
        if (result.ok && body.teachSessionId !== undefined && options.teachMode) {
          try {
            await options.teachMode.record(String(body.teachSessionId), {
              action,
              result,
              resourceKeys: resourceKeysForAction(action)
            });
            teachCaptured = true;
          } catch (error) {
            teachCaptureCode = typeof (error as any)?.code === 'string' ? (error as any).code : 'TEACH_CAPTURE_FAILED';
          }
        }
        try {
          await options.audit?.append({
            ...(action.taskId ? { traceId: action.taskId, taskId: action.taskId } : {}),
            actionId: action.id, providerId: result.provider, capability: action.capability, target: action.target,
            result: result.ok ? 'success' : result.provider === 'policy' ? 'blocked' : 'failure', risk: action.risk,
            details: {
              provenanceKind: action.provenance.kind, durationMs: result.durationMs, errorCode: result.error?.code,
              sideEffectState: result.error?.sideEffectState,
              sessionApproved: Boolean(options.sessionApprovals?.allows(action, approvalAuthority, requestPermissions)),
              autoResumedAfterApproval, enterprisePolicyApplied: requestPermissionDecision.enterpriseApplied,
              enterpriseRoleIds: requestPermissionDecision.roleIds, enterpriseBindingIds: requestPermissionDecision.bindingIds,
              teachCaptured, teachCaptureCode
            }
          });
        } catch (error) {
          result = resultWithAuditDegradation(result, error);
        }
        if (options.actionExecutions) {
          await options.beforeActionReceiptCompletion?.({ action, result });
          if (options.agentKernel && action.risk !== 'read' && result.ok) {
            const reconciled = await options.actionExecutions.reconcileWithKernel(action, approvalAuthority, options.agentKernel.journal);
            if (reconciled.status !== 'completed') {
              throw new OperatorError('ACTION_EXECUTION_RECONCILIATION_REQUIRED', 'Kernel reported success without a durable completed mutation result.', { retryable: false });
            }
          } else {
            await options.actionExecutions.complete(action, result, approvalAuthority);
          }
        }
        send(res, result.ok ? 200 : 409, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const explicitCode = typeof (error as any)?.code === 'string' ? String((error as any).code) : undefined;
        const code = message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : explicitCode ?? 'BAD_REQUEST';
        const status = code === 'REQUEST_TOO_LARGE' ? 413 : code.startsWith('ACTION_EXECUTION_') ? 409 : 400;
        send(res, status, { ok: false, error: { code, message } });
      }
      return;
    }

    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });

  // Keep malformed/slow clients from occupying the authenticated local boundary indefinitely.
  applyBoundedHttpServerPolicy(server);

  return {
    server,
    async listen(host = '127.0.0.1', port = 0): Promise<{ host: string; port: number }> {
      const bindHost = requireLiteralLoopbackBindHost(host, 'Local agent');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindHost, () => resolve());
      });
      const address = server.address() as AddressInfo;
      return { host: bindHost, port: address.port };
    },
    async close(): Promise<void> {
      clearApprovalWaiters();
      abortTeamActions(() => true);
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function resultWithAuditDegradation(result: ActionResult, error: unknown): ActionResult {
  const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'AUDIT_APPEND_FAILED';
  return {
    ...result,
    evidence: [...result.evidence, {
      kind: 'audit_persistence', status: 'fail',
      message: 'The primary action result is authoritative, but its post-execution audit record could not be persisted.',
      data: { code }, timestamp: new Date().toISOString()
    }]
  };
}

function prepareVerifierWorldObservations(input: unknown, missionId: string, workItemId: string): {
  digest: string;
  observations: Array<ReturnType<typeof validateWorldObservation>>;
} {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    throw Object.assign(new Error('worldObservations must contain 1-100 entries.'), { code: 'TEAM_WORLD_OBSERVATION_INVALID' });
  }
  const source = `team:${missionId}:verifier:${workItemId}`;
  const zeroDigest = '0'.repeat(64);
  const observations = input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new Error(`worldObservations[${index}] must be an object.`), { code: 'TEAM_WORLD_OBSERVATION_INVALID' });
    }
    const raw = value as Record<string, unknown>;
    return validateWorldObservation({
      entity: raw.entity as any,
      source,
      domain: raw.domain as any,
      evidenceDigest: zeroDigest,
      facts: raw.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts) ? raw.facts as Record<string, unknown> : {},
      relations: Array.isArray(raw.relations) ? raw.relations as any : [],
      confidence: raw.confidence === undefined ? undefined : Number(raw.confidence),
      ttlMs: raw.ttlMs === undefined ? undefined : Number(raw.ttlMs)
    });
  });
  const committed = observations.map(({ evidenceDigest: _evidenceDigest, ...observation }) => observation);
  const digest = crypto.createHash('sha256').update(JSON.stringify(committed)).digest('hex');
  return { digest, observations };
}

async function publishVerifierWorldObservations(
  world: WorldModelStore,
  mission: Awaited<ReturnType<TeamCoordinator['inspect']>>,
  item: Awaited<ReturnType<TeamCoordinator['inspect']>>['workItems'][number],
  observations: Array<ReturnType<typeof validateWorldObservation>>
): Promise<number> {
  if (item.role !== 'verifier' || item.state !== 'COMPLETED' || item.result?.verificationPassed !== true
    || typeof item.result.verificationDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(item.result.verificationDigest)
    || !item.result.worldObservationDigest) {
    throw Object.assign(new Error('World publication requires a completed passing verifier commitment.'), { code: 'TEAM_WORLD_OBSERVATION_DENIED' });
  }
  const evidenceDigest = crypto.createHash('sha256').update(JSON.stringify({
    missionId: mission.id,
    workItemId: item.id,
    workerId: item.result.workerId,
    completedAt: item.result.completedAt,
    verificationPassed: true,
    verificationDigest: item.result.verificationDigest,
    worldObservationDigest: item.result.worldObservationDigest,
    evidence: item.result.evidence
  })).digest('hex');
  let published = 0;
  for (const observation of observations) {
    await world.observe({ ...observation, evidenceDigest });
    published += 1;
  }
  return published;
}

function withinAuthorizedRoots(input: string, roots: string[]): boolean {
  const candidate = path.resolve(input);
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function taskAuthorizedScope(goal: SemanticTaskGoal, roots: string[]): string[] | null {
  if (!goal || typeof goal !== 'object') return null;
  if (goal.kind === 'autonomous-workflow') {
    if (!Array.isArray(goal.steps) || goal.steps.length < 1 || goal.steps.length > 20) return null;
    const selectedRoots = Array.isArray(goal.roots) ? goal.roots : [];
    if (selectedRoots.some((root) => typeof root !== 'string' || !withinAuthorizedRoots(root, roots))) return null;
    const browserOrigins = Array.isArray(goal.browserOrigins) ? goal.browserOrigins : [];
    const scopes = [
      ...selectedRoots.map((root) => path.resolve(root)),
      ...browserOrigins.map((origin) => `browser:${origin}`),
      ...(goal.application === true ? ['application:uia'] : [])
    ];
    return scopes.length > 0 ? [...new Set(scopes)].sort() : null;
  }
  if (goal.kind === 'semantic-workflow') {
    if (!Array.isArray(goal.steps) || goal.steps.length < 1 || goal.steps.length > 20) return null;
    const scopes: string[] = [];
    for (const step of goal.steps) {
      if ((step as SemanticTaskGoal).kind === 'semantic-workflow') return null;
      const child = taskAuthorizedScope(step, roots);
      if (!child) return null;
      scopes.push(...child);
    }
    return [...new Set(scopes)].sort();
  }
  if (goal.kind === 'browser-navigation') {
    try {
      const url = new URL(String(goal.url ?? ''));
      return [`browser:${url.origin}`];
    } catch { return ['browser:invalid']; }
  }
  if (goal.kind === 'app-operation') return ['application:uia'];
  if (typeof goal.root !== 'string' || !withinAuthorizedRoots(goal.root, roots)) return null;
  return [path.resolve(goal.root)];
}
