import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import type { ActionRisk } from './types.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import type { DigitalOperation, DigitalOperationsLayer, WorldCondition } from './digital-operations.ts';
import type { WorldModelStore } from './world-model.ts';
import { worldValueDigest } from './world-model.ts';

export type DesiredStateStatus = 'PAUSED' | 'HEALTHY' | 'DRIFTED' | 'REMEDIATING' | 'BLOCKED';

export interface DesiredStateAuthority {
  maxRisk: ActionRisk;
  capabilities: string[];
  resources: string[];
}

export interface DesiredStatePolicy {
  autoRemediate: boolean;
  minRemediationIntervalMs: number;
  maxConsecutiveFailures: number;
  maxRemediationsPerDay: number;
}

export interface DesiredStateRemediation {
  objective: string;
  successConditions: string[];
  authority: DesiredStateAuthority;
}

export interface DesiredStateContract {
  version: 1;
  id: string;
  name: string;
  scopeKey: string;
  desired: WorldCondition[];
  remediation: DesiredStateRemediation;
  policy: DesiredStatePolicy;
  status: DesiredStateStatus;
  contractDigest: string;
  activeOperationId?: string;
  lastReason?: string;
  consecutiveFailures: number;
  remediationHistory: Array<{
    operationId: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'verified' | 'failed' | 'cancelled';
  }>;
  createdAt: string;
  updatedAt: string;
}

interface DesiredStateFile {
  version: 1;
  contracts: DesiredStateContract[];
}

const MAX_CONTRACTS = 2000;
const MAX_HISTORY = 200;
const MAX_STATE_BYTES = 24 * 1024 * 1024;
const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'DESIRED_STATE_CORRUPT',
  invalidMessage: 'Desired-state state is invalid.'
} as const;

export class DesiredStateController {
  #file: string;
  #world: WorldModelStore;
  #operations: DigitalOperationsLayer;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, dependencies: {
    world: WorldModelStore;
    operations: DigitalOperationsLayer;
    clock?: () => Date;
  }) {
    this.#file = path.join(path.resolve(stateDir), 'desired-state.json');
    this.#world = dependencies.world;
    this.#operations = dependencies.operations;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async create(input: {
    contractId?: string;
    name: string;
    scopeKey: string;
    desired: WorldCondition[];
    remediation: DesiredStateRemediation;
    policy?: Partial<DesiredStatePolicy>;
  }): Promise<DesiredStateContract> {
    const normalized = normalizeCreate(input);
    return await this.#mutate(async (state, now) => {
      const id = normalized.contractId ?? crypto.randomUUID();
      const digest = contractDigest(normalized);
      const existing = state.contracts.find((item) => item.id === id);
      if (existing) {
        if (existing.contractDigest !== digest) throw new OperatorError('DESIRED_STATE_CONFLICT', 'contractId is already bound to a different desired-state contract.');
        return existing;
      }
      if (state.contracts.length >= MAX_CONTRACTS) {
        const reclaim = state.contracts.findIndex((item) => item.status === 'PAUSED' && !item.activeOperationId);
        if (reclaim < 0) throw new OperatorError('DESIRED_STATE_LIMIT', 'Desired-state contract retention limit reached.');
        state.contracts.splice(reclaim, 1);
      }
      const contract: DesiredStateContract = {
        version: 1,
        id,
        name: normalized.name,
        scopeKey: normalized.scopeKey,
        desired: normalized.desired,
        remediation: normalized.remediation,
        policy: normalized.policy,
        status: 'DRIFTED',
        contractDigest: digest,
        consecutiveFailures: 0,
        remediationHistory: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      state.contracts.push(contract);
      const check = await this.#checkDesired(contract.desired);
      if (check.ok) contract.status = 'HEALTHY';
      else contract.lastReason = check.reason;
      return contract;
    });
  }

  async reconcile(idInput: string): Promise<DesiredStateContract> {
    return await this.#mutate(async (state, now) => {
      const contract = requireContract(state, idInput);
      if (contract.status === 'PAUSED') return contract;

      if (contract.activeOperationId) {
        const active = await this.#operations.refresh(contract.activeOperationId);
        if (!isTerminal(active)) {
          contract.status = active.state === 'BLOCKED' ? 'BLOCKED' : 'REMEDIATING';
          contract.lastReason = active.state === 'BLOCKED'
            ? active.lastBlockReason ?? 'Active remediation is blocked.'
            : 'Remediation operation is still running.';
          contract.updatedAt = now.toISOString();
          return contract;
        }
        this.#closeHistory(contract, active, now);
        delete contract.activeOperationId;
        if (active.state === 'VERIFIED') contract.consecutiveFailures = 0;
        else contract.consecutiveFailures += 1;
      }

      const desired = await this.#checkDesired(contract.desired);
      if (desired.ok) {
        contract.status = 'HEALTHY';
        contract.consecutiveFailures = 0;
        delete contract.lastReason;
        contract.updatedAt = now.toISOString();
        return contract;
      }

      contract.status = 'DRIFTED';
      contract.lastReason = desired.reason;
      contract.updatedAt = now.toISOString();
      if (!contract.policy.autoRemediate) return contract;

      if (contract.consecutiveFailures >= contract.policy.maxConsecutiveFailures) {
        contract.status = 'BLOCKED';
        contract.lastReason = `Automatic remediation is blocked after ${contract.consecutiveFailures} consecutive failed operations. ${desired.reason}`;
        return contract;
      }

      const today = now.toISOString().slice(0, 10);
      const remediationsToday = contract.remediationHistory.filter((item) => item.startedAt.startsWith(today)).length;
      if (remediationsToday >= contract.policy.maxRemediationsPerDay) {
        contract.status = 'BLOCKED';
        contract.lastReason = `Daily automatic remediation limit of ${contract.policy.maxRemediationsPerDay} reached.`;
        return contract;
      }

      const lastStart = contract.remediationHistory.at(-1)?.startedAt;
      if (lastStart && now.getTime() - Date.parse(lastStart) < contract.policy.minRemediationIntervalMs) {
        contract.lastReason = `Drift detected; remediation cooldown is still active. ${desired.reason}`;
        return contract;
      }

      const operation = await this.#operations.submit({
        requestId: crypto.randomUUID(),
        objective: contract.remediation.objective,
        scopeKey: contract.scopeKey,
        successConditions: contract.remediation.successConditions,
        postconditions: contract.desired,
        maxRisk: contract.remediation.authority.maxRisk,
        authority: {
          capabilities: contract.remediation.authority.capabilities,
          resources: contract.remediation.authority.resources
        },
        run: true
      });
      contract.activeOperationId = operation.id;
      contract.status = 'REMEDIATING';
      contract.lastReason = 'Drift detected; bounded remediation operation started.';
      contract.remediationHistory.push({ operationId: operation.id, startedAt: now.toISOString() });
      if (contract.remediationHistory.length > MAX_HISTORY) contract.remediationHistory.splice(0, contract.remediationHistory.length - MAX_HISTORY);
      return contract;
    });
  }

  async pause(idInput: string, options: { cancelActive?: boolean } = {}): Promise<DesiredStateContract> {
    return await this.#mutate(async (state, now) => {
      const contract = requireContract(state, idInput);
      if (options.cancelActive && contract.activeOperationId) {
        const operation = await this.#operations.cancel(contract.activeOperationId);
        this.#closeHistory(contract, operation, now);
        delete contract.activeOperationId;
      }
      contract.status = 'PAUSED';
      contract.lastReason = 'Desired-state reconciliation is paused.';
      contract.updatedAt = now.toISOString();
      return contract;
    });
  }

  async resume(idInput: string): Promise<DesiredStateContract> {
    return await this.#mutate(async (state, now) => {
      const contract = requireContract(state, idInput);
      if (contract.status !== 'PAUSED') throw new OperatorError('DESIRED_STATE_NOT_PAUSED', 'Only paused desired-state contracts can resume.');
      const check = await this.#checkDesired(contract.desired);
      contract.status = check.ok ? 'HEALTHY' : 'DRIFTED';
      contract.lastReason = check.ok ? undefined : check.reason;
      contract.updatedAt = now.toISOString();
      return contract;
    });
  }

  async inspect(idInput: string): Promise<DesiredStateContract> {
    await this.#serial;
    return structuredClone(requireContract(await this.#read(), idInput));
  }

  async list(limitInput = 100): Promise<DesiredStateContract[]> {
    await this.#serial;
    const limit = integer(limitInput, 1, 500, 'limit');
    const state = await this.#read();
    return state.contracts
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  async #checkDesired(conditions: WorldCondition[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (const condition of conditions) {
      const fact = await this.#world.resolveFact(condition.entityKey, condition.factKey);
      if (fact.status !== 'resolved') return { ok: false, reason: `${condition.entityKey}.${condition.factKey} is ${fact.status}.` };
      if (worldValueDigest(fact.value) !== condition.expectedValueDigest) {
        return { ok: false, reason: `${condition.entityKey}.${condition.factKey} differs from the desired verified value.` };
      }
    }
    return { ok: true };
  }

  #closeHistory(contract: DesiredStateContract, operation: DigitalOperation, now: Date): void {
    const item = [...contract.remediationHistory].reverse().find((entry) => entry.operationId === operation.id && !entry.finishedAt);
    if (!item) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Active remediation has no matching history record.');
    item.finishedAt = now.toISOString();
    item.outcome = operation.state === 'VERIFIED' ? 'verified' : operation.state === 'CANCELLED' ? 'cancelled' : 'failed';
  }

  async #mutate<T>(fn: (state: DesiredStateFile, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      output = await fn(state, this.#clock());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }

  async #read(): Promise<DesiredStateFile> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, contracts: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state state could not be read.');
    }
  }
}

function normalizeCreate(input: {
  contractId?: string;
  name: string;
  scopeKey: string;
  desired: WorldCondition[];
  remediation: DesiredStateRemediation;
  policy?: Partial<DesiredStatePolicy>;
}) {
  if (!input || typeof input !== 'object') throw new OperatorError('DESIRED_STATE_INPUT_INVALID', 'Desired-state contract is required.');
  const desired = normalizeConditions(input.desired);
  if (desired.length < 1) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', 'At least one desired world condition is required.');
  const authority = input.remediation?.authority;
  if (!authority) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', 'A bounded remediation authority envelope is required.');
  const policy: DesiredStatePolicy = {
    autoRemediate: input.policy?.autoRemediate === true,
    minRemediationIntervalMs: integer(input.policy?.minRemediationIntervalMs ?? 60_000, 0, 24 * 60 * 60_000, 'minRemediationIntervalMs'),
    maxConsecutiveFailures: integer(input.policy?.maxConsecutiveFailures ?? 3, 1, 20, 'maxConsecutiveFailures'),
    maxRemediationsPerDay: integer(input.policy?.maxRemediationsPerDay ?? 24, 1, 1000, 'maxRemediationsPerDay')
  };
  return {
    contractId: input.contractId === undefined ? undefined : uuid(input.contractId, 'contractId'),
    name: bounded(input.name, 4096, 'name'),
    scopeKey: contextKey(input.scopeKey, 'scopeKey'),
    desired,
    remediation: {
      objective: bounded(input.remediation.objective, 16_384, 'remediation.objective'),
      successConditions: uniqueStrings(input.remediation.successConditions, 100, 4096, 'remediation.successConditions'),
      authority: {
        maxRisk: validRisk(authority.maxRisk),
        capabilities: uniqueStrings(authority.capabilities, 500, 256, 'remediation.authority.capabilities'),
        resources: uniqueStrings(authority.resources, 5000, 1024, 'remediation.authority.resources')
      }
    },
    policy
  };
}

function contractDigest(input: ReturnType<typeof normalizeCreate>): string {
  return crypto.createHash('sha256').update(canonicalJson({
    name: input.name,
    scopeKey: input.scopeKey,
    desired: input.desired,
    remediation: input.remediation,
    policy: input.policy
  })).digest('hex');
}

function normalizeConditions(input: WorldCondition[]): WorldCondition[] {
  if (!Array.isArray(input) || input.length > 200) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', 'desired conditions are invalid.');
  return input.map((condition, index) => ({
    entityKey: contextKey(condition.entityKey, `desired[${index}].entityKey`),
    factKey: key(condition.factKey, `desired[${index}].factKey`),
    expectedValueDigest: sha(condition.expectedValueDigest, `desired[${index}].expectedValueDigest`)
  }));
}

function requireContract(state: DesiredStateFile, idInput: string): DesiredStateContract {
  const id = uuid(idInput, 'contractId');
  const contract = state.contracts.find((item) => item.id === id);
  if (!contract) throw new OperatorError('DESIRED_STATE_NOT_FOUND', 'Desired-state contract was not found.');
  return contract;
}

function validateState(input: unknown): DesiredStateFile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state state must be an object.');
  const state = input as DesiredStateFile;
  if (state.version !== 1 || !Array.isArray(state.contracts) || state.contracts.length > MAX_CONTRACTS) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state state shape is invalid.');
  const ids = new Set<string>();
  for (const contract of state.contracts) {
    uuid(contract.id, 'contract.id');
    if (ids.has(contract.id)) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state contract IDs must be unique.');
    ids.add(contract.id);
    bounded(contract.name, 4096, 'contract.name');
    contextKey(contract.scopeKey, 'contract.scopeKey');
    normalizeConditions(contract.desired);
    bounded(contract.remediation?.objective, 16_384, 'contract.remediation.objective');
    uniqueStrings(contract.remediation?.successConditions, 100, 4096, 'contract.remediation.successConditions');
    validRisk(contract.remediation?.authority?.maxRisk);
    uniqueStrings(contract.remediation?.authority?.capabilities, 500, 256, 'contract.remediation.authority.capabilities');
    uniqueStrings(contract.remediation?.authority?.resources, 5000, 1024, 'contract.remediation.authority.resources');
    if (!contract.policy || typeof contract.policy.autoRemediate !== 'boolean') throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state policy is invalid.');
    integer(contract.policy.minRemediationIntervalMs, 0, 24 * 60 * 60_000, 'contract.policy.minRemediationIntervalMs');
    integer(contract.policy.maxConsecutiveFailures, 1, 20, 'contract.policy.maxConsecutiveFailures');
    integer(contract.policy.maxRemediationsPerDay, 1, 1000, 'contract.policy.maxRemediationsPerDay');
    if (!['PAUSED', 'HEALTHY', 'DRIFTED', 'REMEDIATING', 'BLOCKED'].includes(contract.status)) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state status is invalid.');
    const storedDigest = sha(contract.contractDigest, 'contract.contractDigest');
    const expectedDigest = crypto.createHash('sha256').update(canonicalJson({
      name: contract.name,
      scopeKey: contract.scopeKey,
      desired: contract.desired,
      remediation: contract.remediation,
      policy: contract.policy
    })).digest('hex');
    if (storedDigest !== expectedDigest) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state contract digest does not match the persisted authority contract.');
    integer(contract.consecutiveFailures, 0, 1_000_000, 'contract.consecutiveFailures');
    if (!Array.isArray(contract.remediationHistory) || contract.remediationHistory.length > MAX_HISTORY) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state remediation history is invalid.');
    let unfinished = 0;
    for (const [index, item] of contract.remediationHistory.entries()) {
      uuid(item.operationId, `contract.remediationHistory[${index}].operationId`);
      const startedAt = iso(item.startedAt, `contract.remediationHistory[${index}].startedAt`);
      if (item.finishedAt === undefined) {
        if (item.outcome !== undefined) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Unfinished remediation history cannot have an outcome.');
        unfinished += 1;
      } else {
        const finishedAt = iso(item.finishedAt, `contract.remediationHistory[${index}].finishedAt`);
        if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Remediation history finish cannot precede start.');
        if (!['verified', 'failed', 'cancelled'].includes(String(item.outcome ?? ''))) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Finished remediation history requires a valid outcome.');
      }
    }
    if (unfinished > 1) throw new OperatorError('DESIRED_STATE_CORRUPT', 'At most one remediation operation may be unfinished.');
    if (contract.activeOperationId) {
      uuid(contract.activeOperationId, 'contract.activeOperationId');
      const activeHistory = contract.remediationHistory.find((item) => item.operationId === contract.activeOperationId && item.finishedAt === undefined);
      if (!activeHistory) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Active remediation operation must have one unfinished history record.');
    } else if (unfinished !== 0) {
      throw new OperatorError('DESIRED_STATE_CORRUPT', 'Unfinished remediation history requires an active operation id.');
    }
    const createdAt = iso(contract.createdAt, 'contract.createdAt');
    const updatedAt = iso(contract.updatedAt, 'contract.updatedAt');
    if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new OperatorError('DESIRED_STATE_CORRUPT', 'Desired-state updatedAt cannot precede createdAt.');
  }
  return state;
}

function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new OperatorError('DESIRED_STATE_CORRUPT', `${label} must be an ISO timestamp.`);
  }
  return value;
}

function isTerminal(operation: DigitalOperation): boolean {
  return operation.state === 'VERIFIED' || operation.state === 'FAILED' || operation.state === 'CANCELLED';
}

function validRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(value)) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', 'maxRisk is invalid.');
  return value;
}
function contextKey(input: unknown, label: string): string {
  const value = bounded(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function key(input: unknown, label: string): string {
  const value = bounded(input, 256, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(value)) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function uniqueStrings(input: unknown, max: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((item, index) => bounded(item, maxLength, `${label}[${index}]`));
  if (values.length < 1 || new Set(values).size !== values.length) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} must contain unique values.`);
  return values;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function sha(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('DESIRED_STATE_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}
