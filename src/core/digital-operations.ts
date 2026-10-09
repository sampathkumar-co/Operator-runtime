import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { ProcedureMemoryStore, type ProcedureAssumption, type ProcedureStep } from './procedure-memory.ts';
import { WorldModelStore, worldValueDigest } from './world-model.ts';
import { DevicePoolScheduler, type DevicePoolRequest, type DeviceResourceAdvertisement } from './device-pool.ts';
import { ExecutionOptimizerStore } from './execution-optimizer.ts';
import { TeamCoordinator, type TeamBudget, type TeamWorkInput } from './team-coordinator.ts';
import { OrganizationCoordinator, type OrganizationPolicy } from './organization-coordinator.ts';
import { OutcomePlanner } from './outcome-planner.ts';
import type { ActionRisk } from './types.ts';
import { DurableCompensationJournal, type DurableCompensationIntent } from './compensation-journal.ts';
import { ResourceLeaseStore } from './resource-leases.ts';

type DigitalEffectOperation = 'cancel-team-mission' | 'cancel-organization-program' | 'release-device-reservation';

/**
 * Stable, purpose-separated resource identity issued before any external effect.
 * An uncommitted compensation intent without this binding has no authority to
 * cancel or release a potentially unrelated resource.
 */
export function reservedDigitalEffectId(ownerIdInput: string, operation: DigitalEffectOperation): string {
  const ownerId = validUuid(ownerIdInput, 'operation owner');
  if (!['cancel-team-mission', 'cancel-organization-program', 'release-device-reservation'].includes(operation)) {
    throw new OperatorError('COMPENSATION_OPERATION_INVALID', 'Unsupported recovery effect operation.');
  }
  const bytes = crypto.createHash('sha256')
    .update('digital-operation-reservation-v2\0').update(ownerId).update('\0').update(operation)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MAX_OPERATIONS = 2000;
const MAX_CONDITIONS = 200;
const MAX_STATE_BYTES = 16 * 1024 * 1024;

export type DigitalOperationState = 'PENDING' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'VERIFIED';

export interface WorldCondition {
  entityKey: string;
  factKey: string;
  expectedValueDigest: string;
}

export interface ProcedureCaptureSpec {
  key: string;
  title: string;
  objectiveKind: string;
  assumptions: ProcedureAssumption[];
  steps: ProcedureStep[];
  resources?: string[];
  ttlMs?: number;
}

export interface DigitalOperation {
  version: 1;
  id: string;
  objective: string;
  scopeKey: string;
  successConditions: string[];
  state: DigitalOperationState;
  mode: 'team' | 'organization';
  preconditions: WorldCondition[];
  postconditions: WorldCondition[];
  selectedStrategy: string;
  submissionDigest: string;
  planDigest?: string;
  selectedProcedureId?: string;
  procedureCapture?: ProcedureCaptureSpec;
  deviceReservationId?: string;
  deviceReservationSessionId?: string;
  deviceReservationStatus?: 'active' | 'released' | 'reconciliation_required';
  deviceReservationErrorCode?: string;
  teamMissionId?: string;
  organizationProgramId?: string;
  lastBlockReason?: string;
  outcomeRecorded: boolean;
  verificationEvidenceDigest?: string;
  receiptDigest?: string;
  createdAt: string;
  updatedAt: string;
}

interface OperationsState {
  version: 1;
  operations: DigitalOperation[];
}

export type DigitalExecutionSpec =
  | { kind: 'team'; workItems: TeamWorkInput[]; budget?: Partial<TeamBudget> }
  | {
      kind: 'organization';
      targets: Array<{ key: string; scopeKey: string; workItems: TeamWorkInput[] }>;
      policy?: Partial<OrganizationPolicy>;
    };

export interface DigitalOperationSubmit {
  requestId?: string;
  objective: string;
  scopeKey: string;
  successConditions: string[];
  preconditions?: WorldCondition[];
  postconditions?: WorldCondition[];
  execution?: DigitalExecutionSpec;
  maxRisk?: ActionRisk;
  authority?: {
    capabilities: string[];
    resources: string[];
  };
  budget?: Partial<TeamBudget>;
  procedure?: {
    objectiveKind: string;
    assumptions: ProcedureAssumption[];
    requiredCapabilities?: string[];
  };
  captureProcedure?: ProcedureCaptureSpec;
  strategies?: Array<{ id: string; staticScore: number }>;
  device?: {
    request: DevicePoolRequest;
    advertisements: DeviceResourceAdvertisement[];
  };
  run?: boolean;
}

const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'OPERATIONS_STATE_CORRUPT',
  invalidMessage: 'Digital operations state is invalid.'
} as const;

export class DigitalOperationsLayer {
  #file: string;
  #ownership: ResourceLeaseStore;
  #procedures: ProcedureMemoryStore;
  #world: WorldModelStore;
  #devices: DevicePoolScheduler;
  #optimizer: ExecutionOptimizerStore;
  #teams: TeamCoordinator;
  #organizations: OrganizationCoordinator;
  #planner: OutcomePlanner;
  #availableCapabilities: string[];
  #clock: () => Date;
  #compensations: DurableCompensationJournal;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, dependencies: {
    procedures: ProcedureMemoryStore;
    world: WorldModelStore;
    devices: DevicePoolScheduler;
    optimizer: ExecutionOptimizerStore;
    teams: TeamCoordinator;
    organizations: OrganizationCoordinator;
    planner?: OutcomePlanner;
    availableCapabilities?: string[];
    clock?: () => Date;
    compensations?: DurableCompensationJournal;
  }) {
    this.#file = path.join(path.resolve(stateDir), 'digital-operations.json');
    this.#ownership = new ResourceLeaseStore(stateDir);
    this.#procedures = dependencies.procedures;
    this.#world = dependencies.world;
    this.#devices = dependencies.devices;
    this.#optimizer = dependencies.optimizer;
    this.#teams = dependencies.teams;
    this.#organizations = dependencies.organizations;
    this.#planner = dependencies.planner ?? new OutcomePlanner();
    this.#availableCapabilities = [...new Set(dependencies.availableCapabilities ?? [])].sort();
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#compensations = dependencies.compensations ?? new DurableCompensationJournal(stateDir, { clock: this.#clock });
  }

  async submit(input: DigitalOperationSubmit): Promise<DigitalOperation> {
    return await this.#withOperationOwnership(() => this.#submitOwned(input));
  }

  async #submitOwned(input: DigitalOperationSubmit): Promise<DigitalOperation> {
    const recovery = await this.#recoverPendingCompensationsOwned();
    if (recovery.pending > 0) throw new OperatorError('COMPENSATION_BLOCKED', 'Digital operations has unresolved durable compensation work.', { retryable: true, details: recovery });
    const normalized = normalizeSubmit(input);
    const generatedPlan = normalized.execution ? undefined : this.#planner.plan({
      objective: normalized.objective,
      scopeKey: normalized.scopeKey,
      successConditions: normalized.successConditions,
      maxRisk: normalized.maxRisk,
      availableCapabilities: this.#availableCapabilities,
      ...(normalized.authority ? {
        requestedCapabilities: normalized.authority.capabilities,
        resources: normalized.authority.resources
      } : {}),
      ...(normalized.budget ? { budget: normalized.budget } : {})
    });
    const execution: DigitalExecutionSpec = normalized.execution ?? {
      kind: 'team',
      workItems: generatedPlan!.workItems,
      ...(generatedPlan!.budget ? { budget: generatedPlan!.budget } : {})
    };
    const resolved = { ...normalized, execution, planDigest: generatedPlan?.planDigest };
    const operationId = resolved.requestId ?? crypto.randomUUID();
    const submissionDigest = operationSubmissionDigest(resolved);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const existing = state.operations.find((item) => item.id === operationId);
      if (existing) {
        if (existing.submissionDigest !== submissionDigest) {
          throw new OperatorError('OPERATIONS_REQUEST_CONFLICT', 'Operation requestId is already bound to a different outcome contract.');
        }
        return structuredClone(existing);
      }
      if (state.operations.length >= MAX_OPERATIONS) {
        const reclaim = state.operations.findIndex((item) => ['FAILED', 'CANCELLED', 'VERIFIED'].includes(item.state));
        if (reclaim >= 0) state.operations.splice(reclaim, 1);
        else throw new OperatorError('OPERATIONS_LIMIT', 'Digital operation retention limit reached.');
      }

      await this.#assertWorldConditions(normalized.preconditions, 'precondition');

      let selectedProcedureId: string | undefined;
      const candidateStrategies = normalized.strategies.length > 0 ? [...normalized.strategies] : [{ id: 'fresh-plan', staticScore: 0.5 }];
      if (normalized.procedure) {
        const procedures = await this.#procedures.findReusable({
          objectiveKind: normalized.procedure.objectiveKind,
          scopeKey: normalized.scopeKey,
          assumptions: normalized.procedure.assumptions,
          ...(normalized.procedure.requiredCapabilities ? { requiredCapabilities: normalized.procedure.requiredCapabilities } : {})
        });
        for (const candidate of procedures.slice(0, 20)) {
          if (!candidateStrategies.some((item) => item.id === `procedure:${candidate.procedure.id}`)) {
            candidateStrategies.push({ id: `procedure:${candidate.procedure.id}`, staticScore: Math.max(0.5, candidate.confidence) });
          }
        }
      }
      const strategyContext = strategyContextFor(normalized.scopeKey, resolved.execution.kind);
      const ranked = await this.#optimizer.recommend(strategyContext, candidateStrategies);
      const selectedStrategy = ranked[0]!.id;
      if (selectedStrategy.startsWith('procedure:')) selectedProcedureId = selectedStrategy.slice('procedure:'.length);

      let deviceReservationId: string | undefined;
      let deviceReservationSessionId: string | undefined;
      const compensationIds: string[] = [];
      if (normalized.device) {
        const reservationId = reservedDigitalEffectId(operationId, 'release-device-reservation');
        // Journal *before* resource allocation: an abrupt restart can now name
        // the exact allocation without ever receiving the reserve response.
        const compensationId = await this.#prepareCompensation(operationId, 'release-device-reservation', reservationId);
        compensationIds.push(compensationId);
        try {
          const reservation = await this.#devices.reserve(normalized.device.request, normalized.device.advertisements, { reservationId });
          if (reservation.id !== reservationId) {
            // Contract mismatch with a provider is not a safe success.
            try { await this.#devices.release(reservation.id); } catch { /* unknown effect: retained journal blocks further submissions */ }
            throw new OperatorError('DEVICE_POOL_RESERVATION_ID_CONFLICT', 'Resource scheduler returned a different reservation identity.');
          }
          deviceReservationId = reservation.id;
          deviceReservationSessionId = reservation.sessionId;
        } catch (reserveError) {
          let cleanupError: unknown;
          try { await this.#devices.release(reservationId); }
          catch (error) {
            if (!(error instanceof OperatorError) || error.code !== 'DEVICE_POOL_RESERVATION_NOT_FOUND') cleanupError = error;
          }
          if (!cleanupError) {
            try { await this.#compensations.complete(compensationId); }
            catch (error) { cleanupError = error; }
          }
          if (cleanupError) {
            const code = (error: unknown): string => typeof (error as { code?: unknown } | null)?.code === 'string'
              ? String((error as { code: string }).code) : 'UNKNOWN';
            throw new OperatorError('COMPENSATION_BLOCKED', 'Reservation outcome or recovery journal remains unresolved; new work is blocked.', {
              retryable: true,
              details: { reservationId, reserveCode: code(reserveError), cleanupCode: code(cleanupError) }
            });
          }
          throw reserveError;
        }
      }

      let teamMissionId: string | undefined;
      let organizationProgramId: string | undefined;
      const compensateCreatedExecution = async (): Promise<string[]> => {
        const failed: string[] = [];
        if (teamMissionId) {
          try {
            if ((await this.#teams.cancel(teamMissionId)).state !== 'CANCELLED') failed.push('cancel-team-mission');
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code !== 'TEAM_NOT_FOUND') failed.push('cancel-team-mission');
          }
        }
        if (organizationProgramId) {
          try {
            if ((await this.#organizations.cancel(organizationProgramId)).state !== 'CANCELLED') failed.push('cancel-organization-program');
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code !== 'ORGANIZATION_PROGRAM_NOT_FOUND') failed.push('cancel-organization-program');
          }
        }
        if (deviceReservationId) {
          try {
            if (!['RELEASED', 'EXPIRED'].includes((await this.#devices.release(deviceReservationId)).state)) failed.push('release-device-reservation');
          } catch (error) {
            if (!(error instanceof OperatorError) || error.code !== 'DEVICE_POOL_RESERVATION_NOT_FOUND') failed.push('release-device-reservation');
          }
        }
        for (const id of compensationIds) {
          const intent = (await this.#compensations.pending('digital-operation')).find((item) => item.id === id);
          if (intent && !failed.includes(intent.operation)) {
            try { await this.#compensations.complete(id); }
            catch { failed.push(intent.operation); }
          }
        }
        return failed;
      };
      try {
        if (resolved.execution.kind === 'team') {
          const missionId = reservedDigitalEffectId(operationId, 'cancel-team-mission');
          compensationIds.push(await this.#prepareCompensation(operationId, 'cancel-team-mission', missionId));
          teamMissionId = missionId;
          const mission = await this.#teams.submit({
            missionId,
            objective: normalized.objective,
            workItems: resolved.execution.workItems,
            ...(resolved.execution.budget ? { budget: resolved.execution.budget } : {})
          });
          if (mission.id !== missionId) throw new OperatorError('TEAM_MISSION_ID_CONFLICT', 'Mission creator did not honor the journal-bound mission identity.');
          if (normalized.run) await this.#teams.start(mission.id);
        } else {
          const programId = reservedDigitalEffectId(operationId, 'cancel-organization-program');
          compensationIds.push(await this.#prepareCompensation(operationId, 'cancel-organization-program', programId));
          organizationProgramId = programId;
          const program = await this.#organizations.create({
            programId,
            objective: normalized.objective,
            targets: resolved.execution.targets,
            ...(resolved.execution.policy ? { policy: resolved.execution.policy } : {})
          });
          if (program.id !== programId) throw new OperatorError('ORGANIZATION_PROGRAM_ID_CONFLICT', 'Program creator did not honor the journal-bound program identity.');
          if (normalized.run) await this.#organizations.start(program.id);
        }
      } catch (error) {
        const failed = await compensateCreatedExecution();
        if (failed.length > 0) throw new OperatorError('COMPENSATION_BLOCKED', 'Operation creation failed and durable compensation could not be completed safely.', { retryable: true, details: { failed, cause: error instanceof Error ? error.message : String(error) } });
        throw error;
      }

      const now = this.#clock().toISOString();
      const operation: DigitalOperation = {
        version: 1,
        id: operationId,
        objective: normalized.objective,
        scopeKey: normalized.scopeKey,
        successConditions: normalized.successConditions,
        state: normalized.run ? 'RUNNING' : 'PENDING',
        mode: resolved.execution.kind,
        preconditions: normalized.preconditions,
        postconditions: normalized.postconditions,
        selectedStrategy,
        submissionDigest,
        ...(resolved.planDigest ? { planDigest: resolved.planDigest } : {}),
        ...(selectedProcedureId ? { selectedProcedureId } : {}),
        ...(normalized.captureProcedure ? { procedureCapture: normalized.captureProcedure } : {}),
        ...(deviceReservationId ? { deviceReservationId } : {}),
        ...(deviceReservationSessionId ? { deviceReservationSessionId } : {}),
        ...(deviceReservationId ? { deviceReservationStatus: 'active' as const } : {}),
        ...(teamMissionId ? { teamMissionId } : {}),
        ...(organizationProgramId ? { organizationProgramId } : {}),
        outcomeRecorded: false,
        createdAt: now,
        updatedAt: now
      };
      state.operations.push(operation);
      try {
        await this.#write(state);
      } catch (error) {
        state.operations.pop();
        const failed = await compensateCreatedExecution();
        if (failed.length > 0) throw new OperatorError('COMPENSATION_BLOCKED', 'Operation persistence failed and durable compensation could not be completed safely.', { retryable: true, details: { failed, cause: error instanceof Error ? error.message : String(error) } });
        throw error;
      }
      // The operation now durably owns these resources. Journal cleanup is
      // best-effort here: a retained intent is resolved as committed by restart
      // recovery and must never trigger compensation of a persisted operation.
      for (const id of compensationIds) {
        try { await this.#compensations.complete(id); } catch { /* durable committed intent remains recoverable */ }
      }
      return structuredClone(operation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async recoverPendingCompensations(): Promise<{ recovered: number; pending: number }> {
    return await this.#withOperationOwnership(() => this.#recoverPendingCompensationsOwned());
  }

  async #recoverPendingCompensationsOwned(): Promise<{ recovered: number; pending: number }> {
    const run = this.#serial.then(async () => {
      const intents = await this.#compensations.pending('digital-operation');
      if (intents.length === 0) return { recovered: 0, pending: 0 };
      const state = await this.#read();
      let recovered = 0;
      for (const intent of intents) {
        const operation = state.operations.find((item) => item.id === intent.ownerId);
        if (this.#compensationWasCommitted(intent, operation)) {
          await this.#compensations.complete(intent.id);
          recovered += 1;
          continue;
        }
        // A journal record cannot grant side-effect authority over an arbitrary
        // unrelated child. Legacy/unverifiable intents stay quarantined.
        if (!['cancel-team-mission', 'cancel-organization-program', 'release-device-reservation'].includes(intent.operation)) continue;
        let reservedId: string;
        try {
          reservedId = reservedDigitalEffectId(intent.ownerId, intent.operation as DigitalEffectOperation);
        } catch { continue; }
        if (reservedId !== intent.targetId) continue;
        try {
          if (intent.operation === 'cancel-team-mission') {
            if ((await this.#teams.cancel(intent.targetId)).state !== 'CANCELLED') continue;
          } else if (intent.operation === 'cancel-organization-program') {
            if ((await this.#organizations.cancel(intent.targetId)).state !== 'CANCELLED') continue;
          } else if (intent.operation === 'release-device-reservation') {
            if (!['RELEASED', 'EXPIRED'].includes((await this.#devices.release(intent.targetId)).state)) continue;
          } else continue;
          await this.#compensations.complete(intent.id);
          recovered += 1;
        } catch (error) {
          const code = error instanceof OperatorError ? error.code : '';
          if (['TEAM_NOT_FOUND', 'ORGANIZATION_PROGRAM_NOT_FOUND', 'DEVICE_POOL_RESERVATION_NOT_FOUND'].includes(code)) {
            await this.#compensations.complete(intent.id);
            recovered += 1;
          }
        }
      }
      return { recovered, pending: (await this.#compensations.pending('digital-operation')).length };
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #withOperationOwnership<T>(work: () => Promise<T>): Promise<T> {
    // A process-bound lease spans externally effectful reserve/cancel work and
    // its durable recovery record. Never use a short JSON lock for remote RPC.
    for (let attempt = 0; attempt < 300; attempt += 1) {
      let lease;
      try {
        lease = await this.#ownership.acquire(
          `digital-operation-owner:${crypto.randomUUID()}`, ['digital-operations:recovery'], 'exclusive'
        );
      } catch (error) {
        if (!(error instanceof OperatorError) || error.code !== 'RESOURCE_BUSY') throw error;
        if (attempt === 299) throw new OperatorError('OPERATIONS_RECOVERY_BUSY', 'Another process owns operation submission or compensation recovery.', { retryable: true });
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        continue;
      }
      // Errors from effectful work are never a reason to retry that work.
      try { return await work(); }
      finally { await lease.release(); }
    }
    throw new OperatorError('OPERATIONS_RECOVERY_BUSY', 'Digital operation ownership unavailable.', { retryable: true });
  }

  async #prepareCompensation(ownerId: string, operation: string, targetId: string): Promise<string> {
    if (targetId !== reservedDigitalEffectId(ownerId, operation as DigitalEffectOperation)) {
      throw new OperatorError('COMPENSATION_IDENTITY_CONFLICT', 'Effect identity does not match its immutable operation recovery contract.');
    }
    const id = crypto.createHash('sha256').update(`digital-operation\0${ownerId}\0${operation}\0${targetId}`).digest('hex');
    await this.#compensations.prepare({ id, ownerKind: 'digital-operation', ownerId, operation, targetId });
    return id;
  }

  #compensationWasCommitted(intent: DurableCompensationIntent, operation: DigitalOperation | undefined): boolean {
    if (!operation) return false;
    if (intent.operation === 'cancel-team-mission') return operation.teamMissionId === intent.targetId;
    if (intent.operation === 'cancel-organization-program') return operation.organizationProgramId === intent.targetId;
    if (intent.operation === 'release-device-reservation') return operation.deviceReservationId === intent.targetId;
    return false;
  }

  async start(idInput: string): Promise<DigitalOperation> {
    const id = validUuid(idInput, 'operationId');
    const operation = await this.inspect(id);
    if (operation.state !== 'PENDING' && operation.state !== 'PAUSED') throw new OperatorError('OPERATIONS_STATE_INVALID', 'Operation is not startable.');
    await this.#assertWorldConditions(operation.preconditions, 'precondition');
    if (operation.mode === 'team') {
      if (!operation.teamMissionId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Team operation has no mission.');
      const mission = await this.#teams.inspect(operation.teamMissionId);
      if (mission.state === 'PENDING') await this.#teams.start(mission.id);
      else if (mission.state === 'PAUSED' || mission.state === 'BLOCKED') await this.#teams.resume(mission.id);
    } else {
      if (!operation.organizationProgramId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Organization operation has no program.');
      await this.#organizations.start(operation.organizationProgramId);
    }
    return await this.#update(id, (current) => {
      current.state = 'RUNNING';
      delete current.lastBlockReason;
    });
  }

  async refresh(idInput: string): Promise<DigitalOperation> {
    const id = validUuid(idInput, 'operationId');
    const current = await this.inspect(id);
    if (current.deviceReservationId && current.state === 'RUNNING') {
      if (!current.deviceReservationSessionId) {
        return await this.#update(id, (operation) => {
          operation.state = 'BLOCKED';
          operation.lastBlockReason = 'Device reservation session identity is missing; reconciliation is required.';
        });
      }
      try {
        await this.#devices.heartbeat(current.deviceReservationId, current.deviceReservationSessionId);
      } catch (error) {
        const code = typeof (error as any)?.code === 'string' ? (error as any).code : 'DEVICE_RESERVATION_HEARTBEAT_FAILED';
        return await this.#update(id, (operation) => {
          operation.state = 'BLOCKED';
          operation.lastBlockReason = `Device reservation renewal failed (${code}); capacity ownership is no longer trusted and requires reconciliation.`;
        });
      }
    }
    let underlyingState: string;
    if (current.mode === 'team') {
      if (!current.teamMissionId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Team operation has no mission.');
      underlyingState = (await this.#teams.inspect(current.teamMissionId)).state;
    } else {
      if (!current.organizationProgramId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Organization operation has no program.');
      underlyingState = (await this.#organizations.refresh(current.organizationProgramId)).state;
    }

    let nextState: DigitalOperationState = mapUnderlyingState(underlyingState);
    let blockReason: string | undefined;
    let verificationEvidenceDigest: string | undefined;
    if (nextState === 'VERIFIED') {
      const worldCheck = await this.#checkWorldConditions(current.postconditions);
      if (!worldCheck.ok) {
        nextState = 'BLOCKED';
        blockReason = worldCheck.reason;
      } else {
        verificationEvidenceDigest = await this.#underlyingVerificationDigest(current);
      }
    }

    const updated = await this.#update(id, (operation) => {
      operation.state = nextState;
      if (blockReason) operation.lastBlockReason = blockReason;
      else delete operation.lastBlockReason;
      if (nextState === 'VERIFIED') {
        if (!verificationEvidenceDigest) throw new OperatorError('OPERATIONS_VERIFIER_MISSING', 'Verified operation is missing its underlying machine verification proof.');
        if (operation.verificationEvidenceDigest && operation.verificationEvidenceDigest !== verificationEvidenceDigest) {
          throw new OperatorError('OPERATIONS_VERIFICATION_DRIFT', 'Underlying verification evidence changed after the operation was verified.');
        }
        operation.verificationEvidenceDigest = verificationEvidenceDigest;
        if (!operation.receiptDigest) operation.receiptDigest = operationReceipt(operation);
      }
    });
    if (['VERIFIED', 'FAILED', 'CANCELLED'].includes(updated.state) && !updated.outcomeRecorded) return await this.#recordFinalOutcome(updated);
    return updated;
  }

  async pause(idInput: string): Promise<DigitalOperation> {
    const id = validUuid(idInput, 'operationId');
    const current = await this.inspect(id);
    if (current.mode === 'team' && current.teamMissionId) await this.#teams.pause(current.teamMissionId);
    else if (current.organizationProgramId) await this.#organizations.pause(current.organizationProgramId);
    return await this.#update(id, (operation) => { operation.state = 'PAUSED'; });
  }

  async cancel(idInput: string): Promise<DigitalOperation> {
    const id = validUuid(idInput, 'operationId');
    const current = await this.inspect(id);
    if (current.mode === 'team' && current.teamMissionId) await this.#teams.cancel(current.teamMissionId);
    else if (current.organizationProgramId) await this.#organizations.cancel(current.organizationProgramId);
    const updated = await this.#update(id, (operation) => { operation.state = 'CANCELLED'; });
    return updated.outcomeRecorded ? updated : await this.#recordFinalOutcome(updated);
  }

  async promoteOrganization(idInput: string, verificationDigestInput: string): Promise<DigitalOperation> {
    const id = validUuid(idInput, 'operationId');
    const current = await this.inspect(id);
    if (current.mode !== 'organization' || !current.organizationProgramId) throw new OperatorError('OPERATIONS_MODE_INVALID', 'Operation is not organization-scale.');
    await this.#organizations.promote(current.organizationProgramId, shaDigest(verificationDigestInput, 'verificationDigest'));
    return await this.#update(id, (operation) => { operation.state = 'RUNNING'; });
  }

  async inspect(idInput: string): Promise<DigitalOperation> {
    await this.#serial;
    const id = validUuid(idInput, 'operationId');
    const state = await this.#read();
    const operation = state.operations.find((item) => item.id === id);
    if (!operation) throw new OperatorError('OPERATIONS_NOT_FOUND', 'Digital operation was not found.');
    return structuredClone(operation);
  }

  async list(limitInput = 100): Promise<DigitalOperation[]> {
    await this.#serial;
    const state = await this.#read();
    const limit = boundedInteger(limitInput, 1, 500, 'limit');
    return state.operations.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #recordFinalOutcome(operation: DigitalOperation): Promise<DigitalOperation> {
    const verified = operation.state === 'VERIFIED';
    if (verified) {
      const currentVerificationDigest = await this.#underlyingVerificationDigest(operation);
      if (!operation.verificationEvidenceDigest || operation.verificationEvidenceDigest !== currentVerificationDigest) {
        throw new OperatorError('OPERATIONS_VERIFICATION_DRIFT', 'Verified operation no longer matches its machine-derived underlying verification evidence.');
      }
    }
    const outcomeReceipt = crypto.createHash('sha256').update(JSON.stringify({
      operationId: operation.id,
      submissionDigest: operation.submissionDigest,
      state: operation.state,
      receiptDigest: operation.receiptDigest ?? null
    })).digest('hex');
    let releaseErrorCode: string | undefined;
    try {
      await this.#optimizer.record(strategyContextFor(operation.scopeKey, operation.mode), operation.selectedStrategy, { verified }, outcomeReceipt);
      let capturedProcedureId: string | undefined;
      if (verified && operation.procedureCapture && operation.receiptDigest && operation.verificationEvidenceDigest) {
        const verifierEvidenceDigest = operation.verificationEvidenceDigest;
        const captured = await this.#procedures.recordVerified({
          key: operation.procedureCapture.key,
          title: operation.procedureCapture.title,
          objectiveKind: operation.procedureCapture.objectiveKind,
          scopeKey: operation.scopeKey,
          steps: operation.procedureCapture.steps,
          assumptions: operation.procedureCapture.assumptions,
          resources: operation.procedureCapture.resources,
          verificationDigest: operation.receiptDigest,
          verifierEvidenceDigest,
          ttlMs: operation.procedureCapture.ttlMs
        });
        capturedProcedureId = captured.id;
      }
      if (operation.selectedProcedureId && operation.selectedProcedureId !== capturedProcedureId) {
        await this.#procedures.recordOutcome(operation.selectedProcedureId, verified ? 'verified' : 'failed', outcomeReceipt);
      }
    } finally {
      if (operation.deviceReservationId) {
        try { await this.#devices.release(operation.deviceReservationId); }
        catch (error) { releaseErrorCode = typeof (error as any)?.code === 'string' ? (error as any).code : 'DEVICE_RESERVATION_RELEASE_FAILED'; }
      }
    }
    return await this.#update(operation.id, (current) => {
      current.outcomeRecorded = true;
      if (current.deviceReservationId) {
        current.deviceReservationStatus = releaseErrorCode ? 'reconciliation_required' : 'released';
        if (releaseErrorCode) current.deviceReservationErrorCode = releaseErrorCode;
        else delete current.deviceReservationErrorCode;
      }
    });
  }

  async #underlyingVerificationDigest(operation: DigitalOperation): Promise<string> {
    let evidence: unknown;
    if (operation.mode === 'team') {
      if (!operation.teamMissionId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Verified team operation has no mission.');
      const mission = await this.#teams.inspect(operation.teamMissionId);
      const verifier = mission.workItems.find((item) => item.role === 'verifier'
        && item.state === 'COMPLETED'
        && item.result?.verificationPassed === true
        && typeof item.result.verificationDigest === 'string'
        && /^[0-9a-f]{64}$/i.test(item.result.verificationDigest));
      if (!verifier?.result) throw new OperatorError('OPERATIONS_VERIFIER_MISSING', 'Verified team operation has no accepted verifier result.');
      evidence = { missionId: mission.id, verifierWorkItemId: verifier.id, result: verifier.result };
    } else {
      if (!operation.organizationProgramId) throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Verified organization operation has no program.');
      const program = await this.#organizations.inspect(operation.organizationProgramId);
      if (program.state !== 'VERIFIED') throw new OperatorError('OPERATIONS_VERIFIER_MISSING', 'Organization program is not verified.');
      const targetVerifications: Array<Record<string, unknown>> = [];
      for (const target of program.targets) {
        if (target.state !== 'VERIFIED' || !target.missionId) {
          throw new OperatorError('OPERATIONS_VERIFIER_MISSING', `Organization target ${target.key} is missing a verified mission.`);
        }
        const mission = await this.#teams.inspect(target.missionId);
        if (mission.state !== 'VERIFIED') {
          throw new OperatorError('OPERATIONS_VERIFIER_MISSING', `Organization target ${target.key} mission is not verified.`);
        }
        const verifier = mission.workItems.find((item) => item.role === 'verifier'
          && item.state === 'COMPLETED'
          && item.result?.verificationPassed === true
          && typeof item.result.verificationDigest === 'string'
          && /^[0-9a-f]{64}$/i.test(item.result.verificationDigest));
        if (!verifier?.result) {
          throw new OperatorError('OPERATIONS_VERIFIER_MISSING', `Organization target ${target.key} has no accepted verifier result.`);
        }
        targetVerifications.push({
          targetKey: target.key,
          missionId: mission.id,
          verifierWorkItemId: verifier.id,
          result: verifier.result
        });
      }
      evidence = {
        programId: program.id,
        waves: program.waves.map((wave) => ({ index: wave.index, promotionDigest: wave.promotionDigest ?? null, state: wave.state })),
        targetVerifications
      };
    }
    return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  }

  async #assertWorldConditions(conditions: WorldCondition[], label: string): Promise<void> {
    const result = await this.#checkWorldConditions(conditions);
    if (!result.ok) throw new OperatorError('OPERATIONS_WORLD_CONDITION_FAILED', `${label} failed: ${result.reason}`);
  }

  async #checkWorldConditions(conditions: WorldCondition[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const condition of conditions) {
      const fact = await this.#world.resolveFact(condition.entityKey, condition.factKey);
      if (fact.status !== 'resolved') return { ok: false, reason: `${condition.entityKey}.${condition.factKey} is ${fact.status}.` };
      if (worldValueDigest(fact.value) !== condition.expectedValueDigest) {
        return { ok: false, reason: `${condition.entityKey}.${condition.factKey} resolved value does not match the expected verified value.` };
      }
    }
    return { ok: true };
  }

  async #update(id: string, mutate: (operation: DigitalOperation) => void): Promise<DigitalOperation> {
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const operation = state.operations.find((item) => item.id === id);
      if (!operation) throw new OperatorError('OPERATIONS_NOT_FOUND', 'Digital operation was not found.');
      mutate(operation);
      operation.updatedAt = this.#clock().toISOString();
      validateOperation(operation);
      await this.#write(state);
      return structuredClone(operation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #read(): Promise<OperationsState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, operations: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('OPERATIONS_STATE_CORRUPT', 'Digital operations state could not be read.');
    }
  }

  async #write(state: OperationsState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function normalizeSubmit(input: DigitalOperationSubmit) {
  if (!input || typeof input !== 'object') throw new OperatorError('OPERATIONS_INPUT_INVALID', 'Operation submission is invalid.');
  const successConditions = uniqueStrings(input.successConditions, 100, 4096, 'successConditions');
  if (successConditions.length < 1) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'At least one success condition is required.');
  if (input.execution && !['team', 'organization'].includes(input.execution.kind)) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'Execution specification is invalid.');
  if (input.execution && input.authority) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'authority is only valid for outcome-planned operations without an explicit execution graph.');
  const strategies = (input.strategies ?? []).map((item, index) => ({
    id: boundedKey(item.id, `strategies[${index}].id`),
    staticScore: boundedNumber(item.staticScore, 0, 1, `strategies[${index}].staticScore`)
  }));
  if (strategies.length > 100 || new Set(strategies.map((item) => item.id)).size !== strategies.length) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'Strategy candidates are invalid.');
  return {
    requestId: input.requestId === undefined ? undefined : validUuid(input.requestId, 'requestId'),
    objective: boundedText(input.objective, 16_384, 'objective'),
    scopeKey: boundedContext(input.scopeKey, 'scopeKey'),
    successConditions,
    preconditions: normalizeConditions(input.preconditions ?? []),
    postconditions: normalizeConditions(input.postconditions ?? []),
    execution: input.execution ? structuredClone(input.execution) : undefined,
    maxRisk: input.maxRisk === undefined ? 'read' as ActionRisk : validOperationRisk(input.maxRisk),
    authority: input.authority ? {
      capabilities: uniqueStrings(input.authority.capabilities, 500, 256, 'authority.capabilities'),
      resources: uniqueStrings(input.authority.resources, 5000, 1024, 'authority.resources')
    } : undefined,
    budget: input.budget ? structuredClone(input.budget) : undefined,
    procedure: input.procedure ? {
      objectiveKind: boundedKey(input.procedure.objectiveKind, 'procedure.objectiveKind'),
      assumptions: structuredClone(input.procedure.assumptions),
      requiredCapabilities: input.procedure.requiredCapabilities?.map((item, index) => boundedKey(item, `procedure.requiredCapabilities[${index}]`))
    } : undefined,
    captureProcedure: input.captureProcedure ? normalizeProcedureCapture(input.captureProcedure) : undefined,
    strategies,
    device: input.device ? structuredClone(input.device) : undefined,
    run: input.run === true
  };
}

function normalizeProcedureCapture(input: ProcedureCaptureSpec): ProcedureCaptureSpec {
  if (!input || typeof input !== 'object') throw new OperatorError('OPERATIONS_INPUT_INVALID', 'captureProcedure is invalid.');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 200) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'captureProcedure.steps are invalid.');
  if (!Array.isArray(input.assumptions) || input.assumptions.length > 100) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'captureProcedure.assumptions are invalid.');
  return {
    key: boundedKey(input.key, 'captureProcedure.key'),
    title: boundedText(input.title, 4096, 'captureProcedure.title'),
    objectiveKind: boundedKey(input.objectiveKind, 'captureProcedure.objectiveKind'),
    assumptions: structuredClone(input.assumptions),
    steps: structuredClone(input.steps),
    ...(input.resources ? { resources: uniqueStrings(input.resources, 200, 1024, 'captureProcedure.resources') } : {}),
    ...(input.ttlMs === undefined ? {} : { ttlMs: boundedInteger(input.ttlMs, 60_000, 365 * 24 * 60 * 60_000, 'captureProcedure.ttlMs') })
  };
}

function normalizeConditions(input: WorldCondition[]): WorldCondition[] {
  if (!Array.isArray(input) || input.length > MAX_CONDITIONS) throw new OperatorError('OPERATIONS_INPUT_INVALID', 'World conditions are invalid.');
  return input.map((item, index) => ({
    entityKey: boundedContext(item.entityKey, `conditions[${index}].entityKey`),
    factKey: boundedKey(item.factKey, `conditions[${index}].factKey`),
    expectedValueDigest: shaDigest(item.expectedValueDigest, `conditions[${index}].expectedValueDigest`)
  }));
}

function mapUnderlyingState(state: string): DigitalOperationState {
  if (state === 'VERIFIED') return 'VERIFIED';
  if (state === 'FAILED') return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  if (state === 'PAUSED') return 'PAUSED';
  if (state === 'BLOCKED') return 'BLOCKED';
  if (state === 'PENDING') return 'PENDING';
  return 'RUNNING';
}

function operationSubmissionDigest(normalized: ReturnType<typeof normalizeSubmit>): string {
  const contract = {
    requestId: normalized.requestId ?? null,
    objective: normalized.objective,
    scopeKey: normalized.scopeKey,
    successConditions: normalized.successConditions,
    preconditions: normalized.preconditions,
    postconditions: normalized.postconditions,
    execution: normalized.execution,
    planDigest: (normalized as any).planDigest ?? null,
    maxRisk: normalized.maxRisk,
    authority: normalized.authority ?? null,
    budget: normalized.budget ?? null,
    procedure: normalized.procedure ?? null,
    captureProcedure: normalized.captureProcedure ?? null,
    strategies: normalized.strategies,
    deviceRequest: normalized.device?.request ?? null,
    run: normalized.run
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function operationReceipt(operation: DigitalOperation): string {
  const receipt = {
    version: 1,
    id: operation.id,
    objective: operation.objective,
    scopeKey: operation.scopeKey,
    successConditions: operation.successConditions,
    mode: operation.mode,
    preconditions: operation.preconditions,
    postconditions: operation.postconditions,
    selectedStrategy: operation.selectedStrategy,
    submissionDigest: operation.submissionDigest,
    planDigest: operation.planDigest ?? null,
    selectedProcedureId: operation.selectedProcedureId ?? null,
    deviceReservationId: operation.deviceReservationId ?? null,
    teamMissionId: operation.teamMissionId ?? null,
    organizationProgramId: operation.organizationProgramId ?? null,
    verificationEvidenceDigest: operation.verificationEvidenceDigest ?? null,
    state: 'VERIFIED'
  };
  return crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

function strategyContextFor(scopeKey: string, mode: string): string {
  return boundedKey(('operation-' + mode + '-' + crypto.createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)), 'strategy context');
}

function validateState(input: unknown): OperationsState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as OperationsState;
  if (state.version !== 1 || !Array.isArray(state.operations) || state.operations.length > MAX_OPERATIONS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const operation of state.operations) {
    validateOperation(operation);
    if (ids.has(operation.id)) throw corrupt('Operation IDs must be unique.');
    ids.add(operation.id);
  }
  return structuredClone(state);
}

function validateOperation(operation: DigitalOperation): void {
  if (operation.version !== 1) throw corrupt('Operation version is invalid.');
  validUuid(operation.id, 'operationId'); boundedText(operation.objective, 16_384, 'objective'); boundedContext(operation.scopeKey, 'scopeKey');
  uniqueStrings(operation.successConditions, 100, 4096, 'successConditions');
  if (!['PENDING', 'RUNNING', 'PAUSED', 'BLOCKED', 'FAILED', 'CANCELLED', 'VERIFIED'].includes(operation.state)) throw corrupt('Operation state is invalid.');
  if (!['team', 'organization'].includes(operation.mode)) throw corrupt('Operation mode is invalid.');
  normalizeConditions(operation.preconditions); normalizeConditions(operation.postconditions);
  boundedKey(operation.selectedStrategy, 'selectedStrategy');
  shaDigest(operation.submissionDigest, 'submissionDigest');
  if (operation.planDigest !== undefined) shaDigest(operation.planDigest, 'planDigest');
  if (operation.selectedProcedureId !== undefined) validUuid(operation.selectedProcedureId, 'selectedProcedureId');
  if (operation.procedureCapture !== undefined) normalizeProcedureCapture(operation.procedureCapture);
  if (operation.deviceReservationId !== undefined) validUuid(operation.deviceReservationId, 'deviceReservationId');
  if (operation.deviceReservationSessionId !== undefined) validUuid(operation.deviceReservationSessionId, 'deviceReservationSessionId');
  if (operation.deviceReservationId !== undefined && operation.deviceReservationSessionId === undefined) {
    // Legacy records are accepted and are blocked safely on their next refresh.
  }
  if (operation.deviceReservationStatus !== undefined && !['active', 'released', 'reconciliation_required'].includes(operation.deviceReservationStatus)) throw corrupt('deviceReservationStatus is invalid.');
  if (operation.deviceReservationErrorCode !== undefined) boundedKey(operation.deviceReservationErrorCode, 'deviceReservationErrorCode');
  if (operation.teamMissionId !== undefined) validUuid(operation.teamMissionId, 'teamMissionId');
  if (operation.organizationProgramId !== undefined) validUuid(operation.organizationProgramId, 'organizationProgramId');
  if (operation.lastBlockReason !== undefined) boundedText(operation.lastBlockReason, 4096, 'lastBlockReason');
  if (typeof operation.outcomeRecorded !== 'boolean') throw corrupt('outcomeRecorded is invalid.');
  if (operation.verificationEvidenceDigest !== undefined) shaDigest(operation.verificationEvidenceDigest, 'verificationEvidenceDigest');
  if (operation.receiptDigest !== undefined) shaDigest(operation.receiptDigest, 'receiptDigest');
  if (operation.state === 'VERIFIED') {
    if (!operation.verificationEvidenceDigest || !operation.receiptDigest) throw corrupt('Verified operation is missing its bound verification receipt.');
    if (operation.receiptDigest !== operationReceipt(operation)) throw corrupt('Verified operation receipt does not match its bound contract and verification evidence.');
  } else if (operation.receiptDigest !== undefined || operation.verificationEvidenceDigest !== undefined) {
    throw corrupt('Non-verified operation cannot retain a verification receipt.');
  }
  validIso(operation.createdAt, 'createdAt'); validIso(operation.updatedAt, 'updatedAt');
}

function uniqueStrings(input: unknown, max: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((item, index) => boundedText(item, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} contains duplicates.`);
  return values;
}
function boundedContext(input: unknown, label: string): string {
  const value = boundedText(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedKey(input: unknown, label: string): string {
  const value = boundedText(input, 256, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function validOperationRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(value)) {
    throw new OperatorError('OPERATIONS_INPUT_INVALID', 'maxRisk is invalid.');
  }
  return value;
}

function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  return Math.round(value * 1000) / 1000;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function shaDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} must be UUID.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('OPERATIONS_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
function corrupt(message: string): OperatorError { return new OperatorError('OPERATIONS_STATE_CORRUPT', `Digital operations state is invalid. ${message}`); }
