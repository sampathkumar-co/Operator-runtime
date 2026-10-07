import type { ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';

export type EngineeringObjectiveState =
  | 'CREATED' | 'PLANNED' | 'AUTHORIZED' | 'TWIN_READY' | 'PROOF_GATED'
  | 'EXECUTING' | 'VERIFYING' | 'CERTIFIED' | 'RECOVERY_REQUIRED' | 'FAILED' | 'CANCELLED';

export interface EngineeringObjectiveRecord {
  schemaVersion: 1;
  id: string;
  statement: string;
  constraints: string[];
  authorityDigest: string;
  workspaceGraphId: string;
  state: EngineeringObjectiveState;
  planDigest?: string;
  authorityLeaseId?: string;
  twinId?: string;
  twinStateDigest?: string;
  proofBundleDigest?: string;
  fabricPlanDigest?: string;
  distributedLineageDigests: string[];
  evidencePackId?: string;
  certificationDigest?: string;
  residualUncertainty: string[];
  interruptionCount: number;
  recoveryCount: number;
  resumeState?: Exclude<EngineeringObjectiveState, 'RECOVERY_REQUIRED' | 'CERTIFIED' | 'FAILED' | 'CANCELLED'>;
  recoveryReceiptDigest?: string;
  createdAt: string;
  updatedAt: string;
}

const NAMESPACE = 'r10-engineering-os';
const TRANSITIONS: Readonly<Record<EngineeringObjectiveState, readonly EngineeringObjectiveState[]>> = {
  CREATED: ['PLANNED', 'FAILED', 'CANCELLED'],
  PLANNED: ['AUTHORIZED', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['TWIN_READY', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  TWIN_READY: ['PROOF_GATED', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  PROOF_GATED: ['EXECUTING', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['CERTIFIED', 'RECOVERY_REQUIRED', 'FAILED'],
  CERTIFIED: [],
  RECOVERY_REQUIRED: ['PLANNED', 'AUTHORIZED', 'TWIN_READY', 'PROOF_GATED', 'EXECUTING', 'FAILED', 'CANCELLED'],
  FAILED: [],
  CANCELLED: []
};

export class EngineeringObjectiveLifecycle {
  #store: ControlPlaneStore;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    id: string;
    statement: string;
    constraints: string[];
    authorityDigest: string;
    workspaceGraphId: string;
  }): Promise<EngineeringObjectiveRecord> {
    const now = this.#clock().toISOString();
    const objective: EngineeringObjectiveRecord = {
      schemaVersion: 1,
      id: validId(input.id, 'id'),
      statement: boundedText(input.statement, 16_384, 'statement'),
      constraints: boundedList(input.constraints, 1000, 4096, 'constraints'),
      authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
      workspaceGraphId: digest(input.workspaceGraphId, 'workspaceGraphId'),
      state: 'CREATED',
      distributedLineageDigests: [],
      residualUncertainty: [],
      interruptionCount: 0,
      recoveryCount: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: objectiveKey(objective.id),
      expectedGeneration: null,
      value: objective as unknown as Record<string, unknown>
    }], now);
    return objective;
  }

  async get(objectiveIdInput: string): Promise<EngineeringObjectiveRecord | null> {
    const objectiveId = validId(objectiveIdInput, 'objectiveId');
    const record = await this.#store.get(NAMESPACE, objectiveKey(objectiveId));
    return record ? normalizeObjective(record.value) : null;
  }

  async transition(
    objectiveIdInput: string,
    nextStateInput: EngineeringObjectiveState,
    patch: Partial<EngineeringObjectiveRecord> = {}
  ): Promise<EngineeringObjectiveRecord> {
    const objectiveId = validId(objectiveIdInput, 'objectiveId');
    const stored = await this.#store.get(NAMESPACE, objectiveKey(objectiveId));
    if (!stored) throw new OperatorError('ENGINEERING_OBJECTIVE_NOT_FOUND', 'Engineering objective was not found.');
    const current = normalizeObjective(stored.value);
    const nextState = validState(nextStateInput);
    if (!TRANSITIONS[current.state].includes(nextState)) {
      throw new OperatorError('ENGINEERING_OBJECTIVE_TRANSITION_INVALID', `Objective cannot transition from ${current.state} to ${nextState}.`);
    }
    const next = normalizeObjective({
      ...current,
      ...normalizePatch(patch),
      state: nextState,
      updatedAt: this.#clock().toISOString()
    });
    enforceRequirements(next, current);
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: objectiveKey(objectiveId),
      expectedGeneration: stored.generation,
      value: next as unknown as Record<string, unknown>
    }], next.updatedAt);
    return next;
  }

  async interrupt(objectiveIdInput: string, reasonInput: string): Promise<EngineeringObjectiveRecord> {
    const objectiveId = validId(objectiveIdInput, 'objectiveId');
    const stored = await this.#store.get(NAMESPACE, objectiveKey(objectiveId));
    if (!stored) throw new OperatorError('ENGINEERING_OBJECTIVE_NOT_FOUND', 'Engineering objective was not found.');
    const current = normalizeObjective(stored.value);
    if (['CERTIFIED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(current.state)) {
      throw new OperatorError('ENGINEERING_OBJECTIVE_TRANSITION_INVALID', 'Objective cannot be interrupted from its current state.');
    }
    const next = normalizeObjective({
      ...current,
      state: 'RECOVERY_REQUIRED',
      resumeState: current.state,
      residualUncertainty: [...new Set([...current.residualUncertainty, boundedText(reasonInput, 4096, 'reason')])],
      interruptionCount: current.interruptionCount + 1,
      updatedAt: this.#clock().toISOString()
    });
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: objectiveKey(objectiveId),
      expectedGeneration: stored.generation,
      value: next as unknown as Record<string, unknown>
    }], next.updatedAt);
    return next;
  }

  async resume(objectiveIdInput: string, input: {
    recoveryReceiptDigest: string;
    residualUncertainty?: string[];
  }): Promise<EngineeringObjectiveRecord> {
    const objectiveId = validId(objectiveIdInput, 'objectiveId');
    const stored = await this.#store.get(NAMESPACE, objectiveKey(objectiveId));
    if (!stored) throw new OperatorError('ENGINEERING_OBJECTIVE_NOT_FOUND', 'Engineering objective was not found.');
    const current = normalizeObjective(stored.value);
    if (current.state !== 'RECOVERY_REQUIRED' || !current.resumeState) {
      throw new OperatorError('ENGINEERING_OBJECTIVE_TRANSITION_INVALID', 'Objective is not in resumable recovery state.');
    }
    const next = normalizeObjective({
      ...current,
      state: current.resumeState,
      resumeState: undefined,
      recoveryReceiptDigest: digest(input.recoveryReceiptDigest, 'recoveryReceiptDigest'),
      residualUncertainty: boundedList(input.residualUncertainty ?? [], 1000, 4096, 'residualUncertainty'),
      recoveryCount: current.recoveryCount + 1,
      updatedAt: this.#clock().toISOString()
    });
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: objectiveKey(objectiveId),
      expectedGeneration: stored.generation,
      value: next as unknown as Record<string, unknown>
    }], next.updatedAt);
    return next;
  }
}

export function normalizeEngineeringObjective(input: Record<string, unknown>): EngineeringObjectiveRecord {
  return normalizeObjective(input);
}

export function engineeringObjectiveNamespace(): string {
  return NAMESPACE;
}

function normalizeObjective(input: Record<string, unknown>): EngineeringObjectiveRecord {
  const objective: EngineeringObjectiveRecord = {
    schemaVersion: 1,
    id: validId(input.id, 'id'),
    statement: boundedText(input.statement, 16_384, 'statement'),
    constraints: boundedList(input.constraints, 1000, 4096, 'constraints'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    workspaceGraphId: digest(input.workspaceGraphId, 'workspaceGraphId'),
    state: validState(input.state),
    ...(input.planDigest ? { planDigest: digest(input.planDigest, 'planDigest') } : {}),
    ...(input.authorityLeaseId ? { authorityLeaseId: validId(input.authorityLeaseId, 'authorityLeaseId') } : {}),
    ...(input.twinId ? { twinId: digest(input.twinId, 'twinId') } : {}),
    ...(input.twinStateDigest ? { twinStateDigest: digest(input.twinStateDigest, 'twinStateDigest') } : {}),
    ...(input.proofBundleDigest ? { proofBundleDigest: digest(input.proofBundleDigest, 'proofBundleDigest') } : {}),
    ...(input.fabricPlanDigest ? { fabricPlanDigest: digest(input.fabricPlanDigest, 'fabricPlanDigest') } : {}),
    distributedLineageDigests: digestList(input.distributedLineageDigests ?? [], 100_000, 'distributedLineageDigests'),
    ...(input.evidencePackId ? { evidencePackId: validId(input.evidencePackId, 'evidencePackId') } : {}),
    ...(input.certificationDigest ? { certificationDigest: digest(input.certificationDigest, 'certificationDigest') } : {}),
    residualUncertainty: boundedList(input.residualUncertainty ?? [], 1000, 4096, 'residualUncertainty'),
    interruptionCount: boundedInteger(input.interruptionCount ?? 0, 'interruptionCount'),
    recoveryCount: boundedInteger(input.recoveryCount ?? 0, 'recoveryCount'),
    ...(input.resumeState ? { resumeState: validResumeState(input.resumeState) } : {}),
    ...(input.recoveryReceiptDigest ? { recoveryReceiptDigest: digest(input.recoveryReceiptDigest, 'recoveryReceiptDigest') } : {}),
    createdAt: canonicalIso(input.createdAt, 'createdAt'),
    updatedAt: canonicalIso(input.updatedAt, 'updatedAt')
  };
  if (Date.parse(objective.updatedAt) < Date.parse(objective.createdAt)) throw invalid('updatedAt precedes createdAt.');
  return objective;
}

function normalizePatch(input: Partial<EngineeringObjectiveRecord>): Partial<EngineeringObjectiveRecord> {
  const patch: Partial<EngineeringObjectiveRecord> = {};
  if (input.planDigest !== undefined) patch.planDigest = digest(input.planDigest, 'planDigest');
  if (input.authorityLeaseId !== undefined) patch.authorityLeaseId = validId(input.authorityLeaseId, 'authorityLeaseId');
  if (input.twinId !== undefined) patch.twinId = digest(input.twinId, 'twinId');
  if (input.twinStateDigest !== undefined) patch.twinStateDigest = digest(input.twinStateDigest, 'twinStateDigest');
  if (input.proofBundleDigest !== undefined) patch.proofBundleDigest = digest(input.proofBundleDigest, 'proofBundleDigest');
  if (input.fabricPlanDigest !== undefined) patch.fabricPlanDigest = digest(input.fabricPlanDigest, 'fabricPlanDigest');
  if (input.distributedLineageDigests !== undefined) patch.distributedLineageDigests = digestList(input.distributedLineageDigests, 100_000, 'distributedLineageDigests');
  if (input.evidencePackId !== undefined) patch.evidencePackId = validId(input.evidencePackId, 'evidencePackId');
  if (input.certificationDigest !== undefined) patch.certificationDigest = digest(input.certificationDigest, 'certificationDigest');
  if (input.residualUncertainty !== undefined) patch.residualUncertainty = boundedList(input.residualUncertainty, 1000, 4096, 'residualUncertainty');
  if (input.recoveryReceiptDigest !== undefined) patch.recoveryReceiptDigest = digest(input.recoveryReceiptDigest, 'recoveryReceiptDigest');
  return patch;
}

function enforceRequirements(next: EngineeringObjectiveRecord, previous: EngineeringObjectiveRecord): void {
  if (next.authorityDigest !== previous.authorityDigest || next.workspaceGraphId !== previous.workspaceGraphId) {
    throw invalid('Immutable objective bindings changed.');
  }
  const state = next.state;
  if (['PLANNED', 'AUTHORIZED', 'TWIN_READY', 'PROOF_GATED', 'EXECUTING', 'VERIFYING', 'CERTIFIED'].includes(state) && !next.planDigest) proof();
  if (['AUTHORIZED', 'TWIN_READY', 'PROOF_GATED', 'EXECUTING', 'VERIFYING', 'CERTIFIED'].includes(state) && !next.authorityLeaseId) proof();
  if (['TWIN_READY', 'PROOF_GATED', 'EXECUTING', 'VERIFYING', 'CERTIFIED'].includes(state) && (!next.twinId || !next.twinStateDigest)) proof();
  if (['PROOF_GATED', 'EXECUTING', 'VERIFYING', 'CERTIFIED'].includes(state) && !next.proofBundleDigest) proof();
  if (['EXECUTING', 'VERIFYING', 'CERTIFIED'].includes(state) && !next.fabricPlanDigest) proof();
  if (['VERIFYING', 'CERTIFIED'].includes(state) && next.distributedLineageDigests.length === 0) proof();
  if (state === 'CERTIFIED' && (!next.evidencePackId || !next.certificationDigest || next.residualUncertainty.length > 0)) proof();
}

function objectiveKey(id: string): string { return 'objective:' + id; }
function validState(value: unknown): EngineeringObjectiveState {
  const state = String(value ?? '') as EngineeringObjectiveState;
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, state)) throw invalid('State is invalid.');
  return state;
}
function validResumeState(value: unknown): EngineeringObjectiveRecord['resumeState'] {
  const state = validState(value);
  if (['RECOVERY_REQUIRED', 'CERTIFIED', 'FAILED', 'CANCELLED'].includes(state)) throw invalid('Resume state is invalid.');
  return state as EngineeringObjectiveRecord['resumeState'];
}
function validId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(text)) throw invalid(label + ' is invalid.');
  return text;
}
function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) throw invalid(label + ' is invalid.');
  return value;
}
function boundedList(value: unknown, maxItems: number, maxBytes: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.');
  return [...new Set(value.map((item) => boundedText(item, maxBytes, label)))];
}
function digestList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.');
  return [...new Set(value.map((item) => digest(item, label)))].sort();
}
function digest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalid(label + ' must be SHA-256.');
  return text;
}
function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(label + ' must be canonical ISO.');
  return text;
}
function boundedInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(label + ' is invalid.');
  return number;
}
function proof(): never {
  throw new OperatorError('ENGINEERING_OBJECTIVE_PROOF_REQUIRED', 'Objective lifecycle proof obligations are incomplete.');
}
function invalid(message: string): OperatorError {
  return new OperatorError('ENGINEERING_OS_INVALID', message);
}
