import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { TeamCoordinator, type TeamBudget, type TeamWorkInput } from './team-coordinator.ts';

const MAX_PROGRAMS = 500;
const MAX_TARGETS = 5000;
const MAX_SCOPE_PREFIXES = 100;
const MAX_STATE_BYTES = 32 * 1024 * 1024;

export type OrganizationProgramState = 'PENDING' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'VERIFIED';
export type OrganizationTargetState = 'PENDING' | 'RUNNING' | 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

export interface OrganizationTarget {
  key: string;
  scopeKey: string;
  wave: number;
  state: OrganizationTargetState;
  workItems: TeamWorkInput[];
  missionId?: string;
  updatedAt: string;
}

export interface OrganizationWave {
  index: number;
  targetKeys: string[];
  state: 'PENDING' | 'RUNNING' | 'VERIFIED' | 'FAILED';
  promotedAt?: string;
  promotionDigest?: string;
}

export interface OrganizationPolicy {
  canarySize: number;
  waveSize: number;
  maxParallel: number;
  allowedScopePrefixes: string[];
  teamBudget?: Partial<TeamBudget>;
}

export interface OrganizationProgram {
  version: 1;
  id: string;
  objective: string;
  state: OrganizationProgramState;
  policy: OrganizationPolicy;
  targets: OrganizationTarget[];
  waves: OrganizationWave[];
  activeWave: number;
  createdAt: string;
  updatedAt: string;
}

interface OrganizationState {
  version: 1;
  programs: OrganizationProgram[];
}

const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'ORGANIZATION_STATE_CORRUPT',
  invalidMessage: 'Organization execution state is invalid.'
} as const;

export class OrganizationCoordinator {
  #file: string;
  #teams: TeamCoordinator;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, teams: TeamCoordinator, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'organization-programs.json');
    this.#teams = teams;
    this.#clock = options.clock ?? (() => new Date());
  }

  async create(input: {
    objective: string;
    targets: Array<{ key: string; scopeKey: string; workItems: TeamWorkInput[] }>;
    policy?: Partial<OrganizationPolicy>;
  }): Promise<OrganizationProgram> {
    const objective = boundedText(input.objective, 16_384, 'objective');
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > MAX_TARGETS) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `targets must contain 1-${MAX_TARGETS} entries.`);
    const policy = normalizePolicy(input.policy, input.targets.length);
    const now = this.#clock().toISOString();
    const seen = new Set<string>();
    const normalizedTargets = input.targets.map((target, index) => {
      const key = boundedKey(target.key, `targets[${index}].key`);
      if (seen.has(key)) throw new OperatorError('ORGANIZATION_INPUT_INVALID', 'Target keys must be unique.');
      seen.add(key);
      const scopeKey = boundedContext(target.scopeKey, `targets[${index}].scopeKey`);
      if (!policy.allowedScopePrefixes.some((prefix) => scopeKey === prefix || scopeKey.startsWith(prefix + ':') || scopeKey.startsWith(prefix + '/'))) {
        throw new OperatorError('ORGANIZATION_SCOPE_DENIED', `Target ${key} is outside allowed organization scope prefixes.`);
      }
      if (!Array.isArray(target.workItems) || target.workItems.length < 1) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `Target ${key} requires Stage-4 work items.`);
      return { key, scopeKey, workItems: structuredClone(target.workItems), state: 'PENDING' as const, updatedAt: now };
    });
    const waves = buildWaves(normalizedTargets.map((item) => item.key), policy);
    const waveByTarget = new Map(waves.flatMap((wave) => wave.targetKeys.map((key) => [key, wave.index] as const)));
    const targets: OrganizationTarget[] = normalizedTargets.map((item) => ({ ...item, wave: waveByTarget.get(item.key)! }));
    const program: OrganizationProgram = {
      version: 1,
      id: crypto.randomUUID(),
      objective,
      state: 'PENDING',
      policy,
      targets,
      waves,
      activeWave: 0,
      createdAt: now,
      updatedAt: now
    };
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      if (state.programs.length >= MAX_PROGRAMS) throw new OperatorError('ORGANIZATION_PROGRAM_LIMIT', 'Organization program limit reached.');
      state.programs.push(program);
      await this.#write(state);
      return structuredClone(program);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async start(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    return await this.#mutate(id, async (program) => {
      if (program.state !== 'PENDING' && program.state !== 'PAUSED') throw new OperatorError('ORGANIZATION_STATE_INVALID', 'Only pending/paused programs can start.');
      program.state = 'RUNNING';
      await this.#startWave(program, program.activeWave);
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async refresh(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    return await this.#mutate(id, async (program) => {
      for (const target of program.targets.filter((item) => item.missionId && ['RUNNING', 'BLOCKED'].includes(item.state))) {
        const mission = await this.#teams.inspect(target.missionId!);
        target.state = mission.state === 'VERIFIED' ? 'VERIFIED'
          : mission.state === 'FAILED' ? 'FAILED'
          : mission.state === 'CANCELLED' ? 'CANCELLED'
          : mission.state === 'BLOCKED' || mission.state === 'PAUSED' ? 'BLOCKED'
          : 'RUNNING';
        target.updatedAt = this.#clock().toISOString();
      }
      const wave = program.waves[program.activeWave];
      if (wave?.state === 'RUNNING') {
        const members = program.targets.filter((item) => item.wave === wave.index);
        if (members.some((item) => item.state === 'FAILED' || item.state === 'CANCELLED')) {
          wave.state = 'FAILED';
          program.state = 'FAILED';
        } else if (members.some((item) => item.state === 'BLOCKED')) {
          program.state = 'BLOCKED';
        } else if (members.every((item) => item.state === 'VERIFIED')) {
          wave.state = 'VERIFIED';
          program.state = 'PAUSED';
        }
      }
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async promote(idInput: string, verificationDigestInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    const verificationDigest = shaDigest(verificationDigestInput, 'verificationDigest');
    return await this.#mutate(id, async (program) => {
      const wave = program.waves[program.activeWave];
      if (!wave || wave.state !== 'VERIFIED') throw new OperatorError('ORGANIZATION_PROMOTION_DENIED', 'Current rollout wave is not independently verified.');
      wave.promotedAt = this.#clock().toISOString();
      wave.promotionDigest = verificationDigest;
      if (program.activeWave >= program.waves.length - 1) {
        program.state = 'VERIFIED';
        program.updatedAt = this.#clock().toISOString();
        return;
      }
      program.activeWave += 1;
      program.state = 'RUNNING';
      await this.#startWave(program, program.activeWave);
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async pause(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    return await this.#mutate(id, async (program) => {
      if (!['RUNNING', 'BLOCKED'].includes(program.state)) throw new OperatorError('ORGANIZATION_STATE_INVALID', 'Program is not running.');
      for (const target of program.targets.filter((item) => item.state === 'RUNNING' && item.missionId)) {
        try { await this.#teams.pause(target.missionId!); } catch {}
        target.state = 'BLOCKED';
      }
      program.state = 'PAUSED';
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async cancel(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    return await this.#mutate(id, async (program) => {
      if (['CANCELLED', 'FAILED', 'VERIFIED'].includes(program.state)) return;
      for (const target of program.targets.filter((item) => item.missionId && !['VERIFIED', 'FAILED', 'CANCELLED'].includes(item.state))) {
        try { await this.#teams.cancel(target.missionId!); } catch {}
        target.state = 'CANCELLED';
      }
      program.state = 'CANCELLED';
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async inspect(idInput: string): Promise<OrganizationProgram> {
    await this.#serial;
    const id = validUuid(idInput, 'programId');
    const state = await this.#read();
    const program = state.programs.find((item) => item.id === id);
    if (!program) throw new OperatorError('ORGANIZATION_PROGRAM_NOT_FOUND', 'Organization program was not found.');
    return structuredClone(program);
  }

  async list(limitInput = 100): Promise<OrganizationProgram[]> {
    await this.#serial;
    const state = await this.#read();
    const limit = boundedInteger(limitInput, 1, 500, 'limit');
    return state.programs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #startWave(program: OrganizationProgram, waveIndex: number): Promise<void> {
    const wave = program.waves[waveIndex];
    if (!wave) throw new OperatorError('ORGANIZATION_WAVE_INVALID', 'Rollout wave was not found.');
    if (wave.targetKeys.length > program.policy.maxParallel) throw new OperatorError('ORGANIZATION_PARALLEL_LIMIT', 'Wave exceeds configured parallel blast-radius limit.');
    for (const target of program.targets.filter((item) => item.wave === waveIndex)) {
      if (target.missionId) continue;
      const mission = await this.#teams.submit({
        objective: `${program.objective} [${target.key}]`,
        workItems: target.workItems,
        budget: program.policy.teamBudget
      });
      await this.#teams.start(mission.id);
      target.missionId = mission.id;
      target.state = 'RUNNING';
      target.updatedAt = this.#clock().toISOString();
    }
    wave.state = 'RUNNING';
  }

  async #mutate(id: string, mutate: (program: OrganizationProgram) => Promise<void> | void): Promise<OrganizationProgram> {
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const program = state.programs.find((item) => item.id === id);
      if (!program) throw new OperatorError('ORGANIZATION_PROGRAM_NOT_FOUND', 'Organization program was not found.');
      await mutate(program);
      validateProgram(program);
      await this.#write(state);
      return structuredClone(program);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async #read(): Promise<OrganizationState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, programs: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ORGANIZATION_STATE_CORRUPT', 'Organization state could not be read.');
    }
  }

  async #write(state: OrganizationState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function buildWaves(targetKeys: string[], policy: OrganizationPolicy): OrganizationWave[] {
  const waves: OrganizationWave[] = [];
  let cursor = 0;
  const canary = targetKeys.slice(0, policy.canarySize);
  waves.push({ index: 0, targetKeys: canary, state: 'PENDING' });
  cursor = canary.length;
  let index = 1;
  while (cursor < targetKeys.length) {
    const chunk = targetKeys.slice(cursor, cursor + policy.waveSize);
    waves.push({ index, targetKeys: chunk, state: 'PENDING' });
    cursor += chunk.length;
    index += 1;
  }
  return waves;
}

function normalizePolicy(input: Partial<OrganizationPolicy> | undefined, targetCount: number): OrganizationPolicy {
  const maxParallel = boundedInteger(input?.maxParallel ?? 20, 1, 200, 'maxParallel');
  const canarySize = boundedInteger(input?.canarySize ?? 1, 1, Math.min(targetCount, maxParallel), 'canarySize');
  const waveSize = boundedInteger(input?.waveSize ?? Math.min(20, maxParallel), 1, maxParallel, 'waveSize');
  const allowedScopePrefixes = (input?.allowedScopePrefixes ?? ['org']).map((value, index) => boundedContext(value, `allowedScopePrefixes[${index}]`));
  if (allowedScopePrefixes.length < 1 || allowedScopePrefixes.length > MAX_SCOPE_PREFIXES || new Set(allowedScopePrefixes).size !== allowedScopePrefixes.length) {
    throw new OperatorError('ORGANIZATION_INPUT_INVALID', 'allowedScopePrefixes are invalid.');
  }
  return { canarySize, waveSize, maxParallel, allowedScopePrefixes: allowedScopePrefixes.sort(), ...(input?.teamBudget ? { teamBudget: structuredClone(input.teamBudget) } : {}) };
}

function validateState(input: unknown): OrganizationState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as OrganizationState;
  if (state.version !== 1 || !Array.isArray(state.programs) || state.programs.length > MAX_PROGRAMS) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const program of state.programs) {
    validateProgram(program);
    if (ids.has(program.id)) throw corrupt('Program IDs must be unique.');
    ids.add(program.id);
  }
  return structuredClone(state);
}

function validateProgram(program: OrganizationProgram): void {
  validUuid(program.id, 'programId'); boundedText(program.objective, 16_384, 'objective');
  if (!['PENDING', 'RUNNING', 'PAUSED', 'BLOCKED', 'FAILED', 'CANCELLED', 'VERIFIED'].includes(program.state)) throw corrupt('Program state is invalid.');
  normalizePolicy(program.policy, Math.max(1, program.targets.length));
  if (!Array.isArray(program.targets) || program.targets.length < 1 || program.targets.length > MAX_TARGETS) throw corrupt('Program targets are invalid.');
  if (!Array.isArray(program.waves) || program.waves.length < 1) throw corrupt('Program waves are invalid.');
  boundedInteger(program.activeWave, 0, program.waves.length - 1, 'activeWave');
  validIso(program.createdAt, 'createdAt'); validIso(program.updatedAt, 'updatedAt');
  const targetKeys = new Set<string>();
  for (const target of program.targets) {
    boundedKey(target.key, 'target key'); boundedContext(target.scopeKey, 'scopeKey'); boundedInteger(target.wave, 0, program.waves.length - 1, 'target wave');
    if (targetKeys.has(target.key)) throw corrupt('Target keys must be unique.');
    targetKeys.add(target.key);
    if (!['PENDING', 'RUNNING', 'VERIFIED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(target.state)) throw corrupt('Target state is invalid.');
    if (!Array.isArray(target.workItems) || target.workItems.length < 1) throw corrupt('Target work items are invalid.');
    if (target.missionId !== undefined) validUuid(target.missionId, 'missionId');
    validIso(target.updatedAt, 'target updatedAt');
  }
  for (const wave of program.waves) {
    boundedInteger(wave.index, 0, program.waves.length - 1, 'wave index');
    if (!Array.isArray(wave.targetKeys) || wave.targetKeys.length < 1 || wave.targetKeys.some((key) => !targetKeys.has(key))) throw corrupt('Wave targets are invalid.');
    if (!['PENDING', 'RUNNING', 'VERIFIED', 'FAILED'].includes(wave.state)) throw corrupt('Wave state is invalid.');
    if (wave.promotedAt !== undefined) validIso(wave.promotedAt, 'promotedAt');
    if (wave.promotionDigest !== undefined) shaDigest(wave.promotionDigest, 'promotionDigest');
  }
}

function boundedContext(input: unknown, label: string): string {
  const value = boundedText(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedKey(input: unknown, label: string): string {
  const value = boundedText(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} must be UUID.`);
  return value;
}
function shaDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('ORGANIZATION_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
function corrupt(message: string): OperatorError { return new OperatorError('ORGANIZATION_STATE_CORRUPT', `Organization execution state is invalid. ${message}`); }
