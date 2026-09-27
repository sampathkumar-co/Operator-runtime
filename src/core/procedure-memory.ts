import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import type { ActionRisk } from './types.ts';

const MAX_PROCEDURES = 2000;
const MAX_STEPS = 200;
const MAX_ASSUMPTIONS = 100;
const MAX_RESOURCES = 200;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TTL_MS = 365 * 24 * 60 * 60_000;
const MIN_TTL_MS = 60_000;

export type ProcedureStatus = 'ACTIVE' | 'SUSPENDED' | 'INVALIDATED';

export interface ProcedureStep {
  capability: string;
  risk: ActionRisk;
  summary: string;
}

export interface ProcedureAssumption {
  key: string;
  fingerprint: string;
}

export interface VerifiedProcedure {
  id: string;
  key: string;
  version: number;
  title: string;
  objectiveKind: string;
  scopeKey: string;
  status: ProcedureStatus;
  steps: ProcedureStep[];
  assumptions: ProcedureAssumption[];
  resources: string[];
  verificationDigest: string;
  verifierEvidenceDigest: string;
  verifiedRuns: number;
  failedRuns: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

interface ProcedureMemoryState {
  version: 1;
  procedures: VerifiedProcedure[];
}

export interface ProcedureCandidate {
  procedure: VerifiedProcedure;
  confidence: number;
  reason: string;
}

const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'PROCEDURE_MEMORY_CORRUPT',
  invalidMessage: 'Verified procedure memory is invalid.'
} as const;

export class ProcedureMemoryStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'verified-procedures.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async recordVerified(input: {
    key: string;
    title: string;
    objectiveKind: string;
    scopeKey: string;
    steps: ProcedureStep[];
    assumptions: ProcedureAssumption[];
    resources?: string[];
    verificationDigest: string;
    verifierEvidenceDigest: string;
    ttlMs?: number;
  }): Promise<VerifiedProcedure> {
    const normalized = normalizeProcedureInput(input);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      const existing = state.procedures.find((item) => item.key === normalized.key && item.scopeKey === normalized.scopeKey);
      let procedure: VerifiedProcedure;
      if (existing) {
        if (existing.status === 'INVALIDATED') {
          existing.version += 1;
          existing.status = 'ACTIVE';
          delete existing.invalidatedAt;
          delete existing.invalidationReason;
        } else existing.version += 1;
        existing.title = normalized.title;
        existing.objectiveKind = normalized.objectiveKind;
        existing.steps = normalized.steps;
        existing.assumptions = normalized.assumptions;
        existing.resources = normalized.resources;
        existing.verificationDigest = normalized.verificationDigest;
        existing.verifierEvidenceDigest = normalized.verifierEvidenceDigest;
        existing.verifiedRuns += 1;
        existing.updatedAt = now.toISOString();
        existing.expiresAt = new Date(now.getTime() + normalized.ttlMs).toISOString();
        if (existing.status === 'SUSPENDED') existing.status = 'ACTIVE';
        procedure = existing;
      } else {
        if (state.procedures.length >= MAX_PROCEDURES) {
          state.procedures.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
          const removable = state.procedures.findIndex((item) => item.status !== 'ACTIVE' || Date.parse(item.expiresAt) <= now.getTime());
          if (removable >= 0) state.procedures.splice(removable, 1);
          else throw new OperatorError('PROCEDURE_MEMORY_LIMIT', `At most ${MAX_PROCEDURES} active procedures may be retained.`);
        }
        procedure = {
          id: crypto.randomUUID(),
          key: normalized.key,
          version: 1,
          title: normalized.title,
          objectiveKind: normalized.objectiveKind,
          scopeKey: normalized.scopeKey,
          status: 'ACTIVE',
          steps: normalized.steps,
          assumptions: normalized.assumptions,
          resources: normalized.resources,
          verificationDigest: normalized.verificationDigest,
          verifierEvidenceDigest: normalized.verifierEvidenceDigest,
          verifiedRuns: 1,
          failedRuns: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + normalized.ttlMs).toISOString()
        };
        state.procedures.push(procedure);
      }
      state.procedures.sort((a, b) => procedureIdentity(a).localeCompare(procedureIdentity(b)));
      await this.#write(state);
      return structuredClone(procedure);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async findReusable(input: {
    objectiveKind: string;
    scopeKey: string;
    assumptions: ProcedureAssumption[];
    requiredCapabilities?: string[];
    maxResults?: number;
  }): Promise<ProcedureCandidate[]> {
    await this.#serial;
    const state = await this.#read();
    const now = this.#clock().getTime();
    const objectiveKind = boundedKey(input.objectiveKind, 'objectiveKind');
    const scopeKey = boundedContext(input.scopeKey, 'scopeKey');
    const assumptions = normalizeAssumptions(input.assumptions);
    const current = new Map(assumptions.map((item) => [item.key, item.fingerprint]));
    const required = new Set((input.requiredCapabilities ?? []).map((item, index) => boundedCapability(item, `requiredCapabilities[${index}]`)));
    const maxResults = boundedInteger(input.maxResults ?? 10, 1, 100, 'maxResults');

    return state.procedures
      .filter((procedure) => procedure.status === 'ACTIVE')
      .filter((procedure) => Date.parse(procedure.expiresAt) > now)
      .filter((procedure) => procedure.objectiveKind === objectiveKind && procedure.scopeKey === scopeKey)
      .filter((procedure) => procedure.assumptions.every((item) => current.get(item.key) === item.fingerprint))
      .filter((procedure) => [...required].every((capability) => procedure.steps.some((step) => step.capability === capability)))
      .map((procedure) => ({
        procedure: structuredClone(procedure),
        confidence: procedureConfidence(procedure),
        reason: `Verified procedure assumptions match current scope; verifiedRuns=${procedure.verifiedRuns}, failedRuns=${procedure.failedRuns}.`
      }))
      .sort((a, b) => b.confidence - a.confidence || b.procedure.updatedAt.localeCompare(a.procedure.updatedAt))
      .slice(0, maxResults);
  }

  async recordOutcome(idInput: string, outcome: 'verified' | 'failed'): Promise<VerifiedProcedure> {
    const id = validUuid(idInput, 'procedureId');
    if (outcome !== 'verified' && outcome !== 'failed') throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', 'Procedure outcome is invalid.');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const procedure = state.procedures.find((item) => item.id === id);
      if (!procedure) throw new OperatorError('PROCEDURE_NOT_FOUND', 'Verified procedure was not found.');
      if (procedure.status === 'INVALIDATED') throw new OperatorError('PROCEDURE_INVALIDATED', 'Invalidated procedure cannot record execution outcomes.');
      if (outcome === 'verified') procedure.verifiedRuns += 1;
      else procedure.failedRuns += 1;
      procedure.updatedAt = this.#clock().toISOString();
      if (procedure.failedRuns >= 3 && procedure.failedRuns * 2 >= procedure.verifiedRuns) procedure.status = 'SUSPENDED';
      await this.#write(state);
      return structuredClone(procedure);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async invalidate(idInput: string, reasonInput: string): Promise<VerifiedProcedure> {
    const id = validUuid(idInput, 'procedureId');
    const reason = boundedText(reasonInput, 2048, 'invalidation reason');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const procedure = state.procedures.find((item) => item.id === id);
      if (!procedure) throw new OperatorError('PROCEDURE_NOT_FOUND', 'Verified procedure was not found.');
      procedure.status = 'INVALIDATED';
      procedure.invalidatedAt = this.#clock().toISOString();
      procedure.invalidationReason = reason;
      procedure.updatedAt = procedure.invalidatedAt;
      await this.#write(state);
      return structuredClone(procedure);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async list(limitInput = 100): Promise<VerifiedProcedure[]> {
    await this.#serial;
    const state = await this.#read();
    const limit = boundedInteger(limitInput, 1, 500, 'limit');
    return state.procedures.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #read(): Promise<ProcedureMemoryState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, procedures: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('PROCEDURE_MEMORY_CORRUPT', 'Verified procedure memory could not be read.');
    }
  }

  async #write(state: ProcedureMemoryState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

export function assumptionFingerprint(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', 'Assumption value must be bounded JSON.');
  return crypto.createHash('sha256').update(encoded).digest('hex');
}

function normalizeProcedureInput(input: {
  key: string; title: string; objectiveKind: string; scopeKey: string; steps: ProcedureStep[];
  assumptions: ProcedureAssumption[]; resources?: string[]; verificationDigest: string; verifierEvidenceDigest: string; ttlMs?: number;
}) {
  const steps = normalizeSteps(input.steps);
  const assumptions = normalizeAssumptions(input.assumptions);
  return {
    key: boundedKey(input.key, 'key'),
    title: boundedText(input.title, 4096, 'title'),
    objectiveKind: boundedKey(input.objectiveKind, 'objectiveKind'),
    scopeKey: boundedContext(input.scopeKey, 'scopeKey'),
    steps,
    assumptions,
    resources: uniqueBounded(input.resources ?? [], MAX_RESOURCES, 1024, 'resources'),
    verificationDigest: shaDigest(input.verificationDigest, 'verificationDigest'),
    verifierEvidenceDigest: shaDigest(input.verifierEvidenceDigest, 'verifierEvidenceDigest'),
    ttlMs: boundedInteger(input.ttlMs ?? 30 * 24 * 60 * 60_000, MIN_TTL_MS, MAX_TTL_MS, 'ttlMs')
  };
}

function normalizeSteps(input: ProcedureStep[]): ProcedureStep[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_STEPS) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `steps must contain 1-${MAX_STEPS} entries.`);
  return input.map((step, index) => ({
    capability: boundedCapability(step.capability, `steps[${index}].capability`),
    risk: validRisk(step.risk),
    summary: boundedText(step.summary, 4096, `steps[${index}].summary`)
  }));
}

function normalizeAssumptions(input: ProcedureAssumption[]): ProcedureAssumption[] {
  if (!Array.isArray(input) || input.length > MAX_ASSUMPTIONS) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `assumptions may contain at most ${MAX_ASSUMPTIONS} entries.`);
  const seen = new Set<string>();
  return input.map((item, index) => {
    const key = boundedKey(item.key, `assumptions[${index}].key`);
    if (seen.has(key)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', 'Assumption keys must be unique.');
    seen.add(key);
    return { key, fingerprint: shaDigest(item.fingerprint, `assumptions[${index}].fingerprint`) };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function validateState(input: unknown): ProcedureMemoryState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.procedures) || raw.procedures.length > MAX_PROCEDURES) throw corrupt('State version/procedure collection is invalid.');
  const identities = new Set<string>();
  const ids = new Set<string>();
  const procedures = raw.procedures.map((value, index): VerifiedProcedure => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt(`Procedure ${index} must be an object.`);
    const item = value as VerifiedProcedure;
    validUuid(item.id, `procedure ${index} id`);
    if (ids.has(item.id)) throw corrupt('Procedure IDs must be unique.');
    ids.add(item.id);
    boundedKey(item.key, `procedure ${index} key`);
    boundedInteger(item.version, 1, Number.MAX_SAFE_INTEGER, `procedure ${index} version`);
    boundedText(item.title, 4096, `procedure ${index} title`);
    boundedKey(item.objectiveKind, `procedure ${index} objectiveKind`);
    boundedContext(item.scopeKey, `procedure ${index} scopeKey`);
    if (!['ACTIVE', 'SUSPENDED', 'INVALIDATED'].includes(item.status)) throw corrupt('Procedure status is invalid.');
    normalizeSteps(item.steps);
    normalizeAssumptions(item.assumptions);
    uniqueBounded(item.resources, MAX_RESOURCES, 1024, 'resources');
    shaDigest(item.verificationDigest, 'verificationDigest');
    shaDigest(item.verifierEvidenceDigest, 'verifierEvidenceDigest');
    boundedInteger(item.verifiedRuns, 0, Number.MAX_SAFE_INTEGER, 'verifiedRuns');
    boundedInteger(item.failedRuns, 0, Number.MAX_SAFE_INTEGER, 'failedRuns');
    validIso(item.createdAt, 'createdAt'); validIso(item.updatedAt, 'updatedAt'); validIso(item.expiresAt, 'expiresAt');
    if (item.invalidatedAt !== undefined) validIso(item.invalidatedAt, 'invalidatedAt');
    if (item.invalidationReason !== undefined) boundedText(item.invalidationReason, 2048, 'invalidationReason');
    const identity = procedureIdentity(item);
    if (identities.has(identity)) throw corrupt('Procedure key/scope identities must be unique.');
    identities.add(identity);
    return structuredClone(item);
  });
  return { version: 1, procedures };
}

function procedureConfidence(procedure: VerifiedProcedure): number {
  const total = procedure.verifiedRuns + procedure.failedRuns;
  const posterior = (procedure.verifiedRuns + 2) / (total + 4);
  const evidenceConfidence = Math.min(1, total / 10);
  return Math.round((0.5 + (posterior - 0.5) * evidenceConfidence) * 1000) / 1000;
}

function procedureIdentity(item: Pick<VerifiedProcedure, 'key' | 'scopeKey'>): string { return `${item.key}\0${item.scopeKey}`; }
function boundedCapability(input: unknown, label: string): string {
  const value = boundedText(input, 256, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedKey(input: unknown, label: string): string {
  const value = boundedText(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedContext(input: unknown, label: string): string {
  const value = boundedText(input, 256, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function uniqueBounded(input: string[], max: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => boundedText(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} must not contain duplicates.`);
  return values.sort();
}
function shaDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} must be a SHA-256 digest.`);
  return value;
}
function validRisk(input: unknown): ActionRisk {
  const value = String(input ?? '') as ActionRisk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', 'Procedure step risk is invalid.');
  return value;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} must be a UUID.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('PROCEDURE_MEMORY_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function corrupt(message: string): OperatorError { return new OperatorError('PROCEDURE_MEMORY_CORRUPT', `Verified procedure memory is invalid. ${message}`); }
