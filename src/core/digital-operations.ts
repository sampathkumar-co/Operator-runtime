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
  #procedures: ProcedureMemoryStore;
  #world: WorldModelStore;
  #devices: DevicePoolScheduler;
  #optimizer: ExecutionOptimizerStore;
  #teams: TeamCoordinator;
  #organizations: OrganizationCoordinator;
  #planner: OutcomePlanner;
  #availableCapabilities: string[];
  #clock: () => Date;
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
  }) {
    this.#file = path.join(path.resolve(stateDir), 'digital-operations.json');
    this.#procedures = dependencies.procedures;
    this.#world = dependencies.world;
    this.#devices = dependencies.devices;
    this.#optimizer = dependencies.optimizer;
    this.#teams = dependencies.teams;
    this.#organizations = dependencies.organizations;
    this.#planner = dependencies.planner ?? new OutcomePlanner();
    this.#availableCapabilities = [...new Set(dependencies.availableCapabilities ?? [])].sort();
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async submit(input: DigitalOperationSubmit): Promise<DigitalOperation> {
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
      if (normalized.device) {
        const reservation = await this.#devices.reserve(normalized.device.request, normalized.device.advertisements);
        deviceReservationId = reservation.id;
        deviceReservationSessionId = reservation.sessionId;
      }

      let teamMissionId: string | undefined;
      let organizationProgramId: string | undefined;
      const compensateCreatedExecution = async () => {
        if (teamMissionId) {
          try { await this.#teams.cancel(teamMissionId); } catch {}
        }
        if (organizationProgramId) {
          try { await this.#organizations.cancel(organizationProgramId); } catch {}
        }
        if (deviceReservationId) {
          try { await this.#devices.release(deviceReservationId); } catch {}
        }
      };
      try {
        if (resolved.execution.kind === 'team') {
          const mission = await this.#teams.submit({
            objective: normalized.objective,
            workItems: resolved.execution.workItems,
            ...(resolved.execution.budget ? { budget: resolved.execution.budget } : {})
          });
          teamMissionId = mission.id;
          if (normalized.run) await this.#teams.start(mission.id);
        } else {
          const program = await this.#organizations.create({
            objective: normalized.objective,
            targets: resolved.execution.targets,
            ...(resolved.execution.policy ? { policy: resolved.execution.policy } : {})
          });
          organizationProgramId = program.id;
          if (normalized.run) await this.#organizations.start(program.id);
        }
      } catch (error) {
        await compensateCreatedExecution();
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
        await compensateCreatedExecution();
        throw error;
      }
      return structuredClone(operation);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
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
    if (nextState === 'VERIFIED') {
      const worldCheck = await this.#checkWorldConditions(current.postconditions);
      if (!worldCheck.ok) {
        nextState = 'BLOCKED';
        blockReason = worldCheck.reason;
      }
    }

    const updated = await this.#update(id, (operation) => {
      operation.state = nextState;
      if (blockReason) operation.lastBlockReason = blockReason;
      else delete operation.lastBlockReason;
      if (nextState === 'VERIFIED' && !operation.receiptDigest) operation.receiptDigest = operationReceipt(operation);
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
      if (verified && operation.procedureCapture && operation.receiptDigest) {
        const verifierEvidenceDigest = await this.#underlyingVerificationDigest(operation);
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
      const verifier = mission.workItems.find((item) => item.role === 'verifier' && item.state === 'COMPLETED' && item.result?.verificationPassed === true);
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
        const verifier = mission.workItems.find((item) => item.role === 'verifier' && item.state === 'COMPLETED' && item.result?.verificationPassed === true);
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
  if (operation.receiptDigest !== undefined) shaDigest(operation.receiptDigest, 'receiptDigest');
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
