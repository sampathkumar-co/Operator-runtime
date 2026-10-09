import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { stableOrganizationMissionId, organizationCompensationIntentId as compensationIntentId } from './organization-identity.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { TeamCoordinator, type TeamBudget, type TeamWorkInput } from './team-coordinator.ts';
import { DurableCompensationJournal, type DurableCompensationIntent } from './compensation-journal.ts';
import { OrganizationQuarantineAdjudicator, type SignedProviderQuarantineClaim, type QuarantineAdjudicationRecord } from './organization-quarantine-adjudication.ts';

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
  controlFailure?: { operation: 'pause' | 'cancel'; code: string; message: string; at: string };
}

export interface OrganizationWave {
  index: number;
  targetKeys: string[];
  state: 'PENDING' | 'RUNNING' | 'VERIFIED' | 'FAILED';
  verificationDigest?: string;
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

interface OrganizationMutationTransaction {
  onRollback(callback: () => Promise<void> | void): void;
  onCommit(callback: () => Promise<void> | void): void;
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
  #compensations: DurableCompensationJournal;
  #adjudicator?: OrganizationQuarantineAdjudicator;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, teams: TeamCoordinator, options: {
    clock?: () => Date;
    compensations?: DurableCompensationJournal;
    adjudicator?: OrganizationQuarantineAdjudicator;
  } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'organization-programs.json');
    this.#teams = teams;
    this.#clock = options.clock ?? (() => new Date());
    this.#compensations = options.compensations ?? new DurableCompensationJournal(stateDir, { clock: this.#clock });
    this.#adjudicator = options.adjudicator;
  }

  async create(input: {
    programId?: string;
    objective: string;
    targets: Array<{ key: string; scopeKey: string; workItems: TeamWorkInput[] }>;
    policy?: Partial<OrganizationPolicy>;
  }): Promise<OrganizationProgram> {
    const objective = boundedText(input.objective, 16_384, 'objective');
    const programId = input.programId === undefined ? crypto.randomUUID() : validUuid(input.programId, 'programId');
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
      id: programId,
      objective,
      state: 'PENDING',
      policy,
      targets,
      waves,
      activeWave: 0,
      createdAt: now,
      updatedAt: now
    };
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      if (state.programs.some((item) => item.id === programId)) throw new OperatorError('ORGANIZATION_PROGRAM_ID_CONFLICT', 'Existing program identity cannot be reallocated.');
      if (state.programs.length >= MAX_PROGRAMS) {
        const terminal = state.programs
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => ['VERIFIED', 'FAILED', 'CANCELLED'].includes(item.state))
          .sort((a, b) => a.item.updatedAt.localeCompare(b.item.updatedAt) || a.item.id.localeCompare(b.item.id))[0];
        if (!terminal) throw new OperatorError('ORGANIZATION_PROGRAM_LIMIT', 'Organization program limit reached with no terminal program eligible for retention reclamation.');
        state.programs.splice(terminal.index, 1);
      }
      state.programs.push(program);
      await this.#write(state);
      return structuredClone(program);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async recoverPendingCompensations(): Promise<{ recovered: number; pending: number }> {
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const intents = await this.#compensations.pending('organization');
      if (intents.length === 0) return { recovered: 0, pending: 0 };
      const state = await this.#read();
      let recovered = 0;
      for (const intent of intents) {
        const program = state.programs.find((item) => item.id === intent.ownerId);
        const target = program?.targets.find((item) => item.key === intent.subjectKey);
        if (this.#compensationWasCommitted(intent, program, target)) {
          await this.#compensations.complete(intent.id);
          recovered += 1;
          continue;
        }
        // Unknown child identities are not cancellation authority. Preserve the
        // quarantine intent for explicit operator reconciliation on every restart.
        if (intent.operation === 'reconcile-untrusted-team-identity') continue;
        // Deterministic IDs alone cannot prove the child was created here.
        // Require the provider's successful, exact-identity acknowledgement.
        if (!intent.confirmedAt) continue;
        // A journal entry is not proof of authority over a child mission.
        // Only the deterministic preallocated ID of the exact program target
        // can be used for any cleanup side effect.
        if (!program || !target ||
            intent.targetId !== stableOrganizationMissionId(program.id, target.key)) continue;
        try {
          const mission = await this.#teams.inspect(intent.targetId);
          // Provider lookup identity and returned terminal state are separate
          // claims. A provider returning another mission's object must NEVER
          // grant cancellation authority or complete this recovery journal.
          if (!mission || mission.id !== intent.targetId) continue;
          if (intent.operation === 'cancel-team-mission') {
            // A terminal FAILED/VERIFIED mission may have irreversible effects.
            // It is not evidence that a requested cancellation succeeded.
            if (mission.state !== 'CANCELLED') {
              if (['FAILED', 'VERIFIED'].includes(mission.state)) continue;
              const cancelled = await this.#teams.cancel(intent.targetId);
              if (!cancelled || cancelled.id !== intent.targetId ||
                  cancelled.state !== 'CANCELLED') continue;
            }
          } else if (intent.operation === 'pause-team-mission') {
            if (mission.state === 'RUNNING' || mission.state === 'BLOCKED') {
              const paused = await this.#teams.pause(intent.targetId);
              if (!paused || paused.id !== intent.targetId ||
                  paused.state !== 'PAUSED') continue;
            } else if (mission.state !== 'PAUSED') {
              continue;
            }
          } else {
            continue;
          }
          await this.#compensations.complete(intent.id);
          recovered += 1;
        } catch {
          // Not-found is a snapshot of one provider's observation, not proof
          // that the exact acknowledged mission was never created. Preserve
          // the durable compensation for evidence-backed reconciliation.
        }
      }
      const remaining = (await this.#compensations.pending('organization')).length;
      return { recovered, pending: remaining };
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async start(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    await this.recoverPendingCompensations();
    await this.#assertNoPendingCompensation(id);
    return await this.#mutate(id, async (program, transaction) => {
      if (program.state !== 'PENDING' && program.state !== 'PAUSED' && program.state !== 'BLOCKED') throw new OperatorError('ORGANIZATION_STATE_INVALID', 'Only pending/paused/blocked programs can start.');
      const wasPaused = program.state === 'PAUSED' || program.state === 'BLOCKED';
      program.state = 'RUNNING';
      if (wasPaused) {
        for (const target of program.targets.filter((item) => item.wave === program.activeWave && item.missionId && item.state === 'BLOCKED')) {
          const mission = await this.#teams.inspect(target.missionId!);
          if (mission.state === 'PAUSED' || mission.state === 'BLOCKED') {
            const compensationId = compensationIntentId(program.id, 'pause-team-mission', mission.id);
            await this.#compensations.prepare({
              id: compensationId,
              ownerKind: 'organization',
              ownerId: program.id,
              operation: 'pause-team-mission',
              targetId: mission.id,
              subjectKey: target.key
            });
            transaction.onCommit(async () => { await this.#compensations.complete(compensationId); });
            transaction.onRollback(async () => {
              try {
                const paused = await this.#teams.pause(mission.id);
                if (paused.state === 'PAUSED') await this.#compensations.complete(compensationId);
              } catch {}
            });
            const resumed = await this.#teams.resume(mission.id);
            if (resumed.state !== 'RUNNING') throw new OperatorError('ORGANIZATION_CHILD_RESUME_UNCONFIRMED', 'Child mission did not confirm resume before organization advancement.');
          }
          target.state = mission.state === 'VERIFIED' ? 'VERIFIED' : 'RUNNING';
          target.updatedAt = this.#clock().toISOString();
        }
      }
      await this.#startWave(program, program.activeWave, transaction);
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async refresh(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    await this.recoverPendingCompensations();
    await this.#assertNoPendingCompensation(id);
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
          wave.verificationDigest = await this.#verifiedWaveDigest(program, wave);
          wave.state = 'VERIFIED';
          program.state = 'PAUSED';
        }
      }
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async promote(idInput: string, verificationDigestInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    await this.recoverPendingCompensations();
    await this.#assertNoPendingCompensation(id);
    const expectedVerificationDigest = shaDigest(verificationDigestInput, 'verificationDigest');
    return await this.#mutate(id, async (program, transaction) => {
      const wave = program.waves[program.activeWave];
      if (!wave || wave.state !== 'VERIFIED') throw new OperatorError('ORGANIZATION_PROMOTION_DENIED', 'Current rollout wave is not independently verified.');
      const verificationDigest = await this.#verifiedWaveDigest(program, wave);
      if (wave.verificationDigest && wave.verificationDigest !== verificationDigest) {
        throw new OperatorError('ORGANIZATION_VERIFICATION_DRIFT', 'Current rollout wave verification evidence changed after it was marked verified.');
      }
      if (expectedVerificationDigest !== verificationDigest) {
        throw new OperatorError('ORGANIZATION_VERIFICATION_DIGEST_MISMATCH', 'Promotion digest does not match the current machine-derived wave verification proof.');
      }
      wave.verificationDigest = verificationDigest;
      wave.promotedAt = this.#clock().toISOString();
      wave.promotionDigest = verificationDigest;
      if (program.activeWave >= program.waves.length - 1) {
        program.state = 'VERIFIED';
        program.updatedAt = this.#clock().toISOString();
        return;
      }
      program.activeWave += 1;
      program.state = 'RUNNING';
      await this.#startWave(program, program.activeWave, transaction);
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async #verifiedWaveDigest(program: OrganizationProgram, wave: OrganizationWave): Promise<string> {
    const proofs: Array<Record<string, unknown>> = [];
    for (const targetKey of [...wave.targetKeys].sort()) {
      const target = program.targets.find((candidate) => candidate.key === targetKey);
      if (!target || target.state !== 'VERIFIED' || !target.missionId) {
        throw new OperatorError('ORGANIZATION_VERIFICATION_MISSING', `Target ${targetKey} is missing a verified mission proof.`);
      }
      const mission = await this.#teams.inspect(target.missionId);
      if (mission.state !== 'VERIFIED') {
        throw new OperatorError('ORGANIZATION_VERIFICATION_MISSING', `Target ${targetKey} mission is not currently verified.`);
      }
      const verifiers = mission.workItems.filter((item) =>
        item.role === 'verifier'
        && item.state === 'COMPLETED'
        && item.result?.verificationPassed === true
        && typeof item.result.verificationDigest === 'string'
        && /^[0-9a-f]{64}$/i.test(item.result.verificationDigest)
      ).map((item) => ({
        workItemId: item.id,
        verificationDigest: item.result!.verificationDigest!.toLowerCase(),
        worldObservationDigest: item.result?.worldObservationDigest ?? null
      })).sort((left, right) => left.workItemId.localeCompare(right.workItemId));
      if (verifiers.length === 0) {
        throw new OperatorError('ORGANIZATION_VERIFICATION_MISSING', `Target ${targetKey} has no accepted verifier receipt.`);
      }
      proofs.push({ targetKey, missionId: mission.id, verifiers });
    }
    return crypto.createHash('sha256').update(JSON.stringify({
      purpose: 'mecord-organization-wave-verification-v1',
      programId: program.id,
      waveIndex: wave.index,
      proofs
    })).digest('hex');
  }

  async pause(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    await this.recoverPendingCompensations();
    await this.#assertNoPendingCompensation(id);
    return await this.#mutate(id, async (program) => {
      if (!['RUNNING', 'BLOCKED'].includes(program.state)) throw new OperatorError('ORGANIZATION_STATE_INVALID', 'Program is not running.');
      let failed = false;
      for (const target of program.targets.filter((item) => item.state === 'RUNNING' && item.missionId)) {
        try {
          const mission = await this.#teams.pause(target.missionId!);
          if (mission.state !== 'PAUSED') throw new OperatorError('ORGANIZATION_CHILD_PAUSE_UNCONFIRMED', 'Child mission did not confirm a paused state.');
          target.state = 'BLOCKED';
          delete target.controlFailure;
        } catch (error) {
          failed = true;
          target.controlFailure = controlFailure('pause', error, this.#clock());
        }
        target.updatedAt = this.#clock().toISOString();
      }
      program.state = failed ? 'BLOCKED' : 'PAUSED';
      program.updatedAt = this.#clock().toISOString();
    });
  }

  async cancel(idInput: string): Promise<OrganizationProgram> {
    const id = validUuid(idInput, 'programId');
    await this.recoverPendingCompensations();
    await this.#assertNoPendingCompensation(id);
    return await this.#mutate(id, async (program) => {
      if (['CANCELLED', 'FAILED', 'VERIFIED'].includes(program.state)) return;
      let failed = false;
      for (const target of program.targets.filter((item) => item.missionId && !['VERIFIED', 'FAILED', 'CANCELLED'].includes(item.state))) {
        try {
          const mission = await this.#teams.cancel(target.missionId!);
          if (mission.state !== 'CANCELLED') throw new OperatorError('ORGANIZATION_CHILD_CANCEL_UNCONFIRMED', 'Child mission did not confirm terminal cancellation.');
          target.state = 'CANCELLED';
          delete target.controlFailure;
        } catch (error) {
          failed = true;
          target.controlFailure = controlFailure('cancel', error, this.#clock());
        }
        target.updatedAt = this.#clock().toISOString();
      }
      program.state = failed ? 'BLOCKED' : 'CANCELLED';
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

  /**
   * Authenticated human review of an untrusted provider-returned mission ID.
   * This API cannot cancel a returned child. Owned cases remain quarantined;
   * unrelated/not-created cases retire only the returned-identity quarantine,
   * never the original preallocated recovery intent.
   */
  async adjudicateQuarantinedIdentity(input: {
    programId: string; targetKey: string; returnedMissionId: string;
    operatorId: string; providerClaim: SignedProviderQuarantineClaim;
  }): Promise<QuarantineAdjudicationRecord> {
    if (!this.#adjudicator) throw new OperatorError('QUARANTINE_ADJUDICATION_UNAVAILABLE',
      'Independent provider signing and scoped operator authorization must be configured.');
    const program = await this.inspect(validUuid(input.programId, 'programId'));
    const targetKey = boundedKey(input.targetKey, 'targetKey');
    const target = program.targets.find((item) => item.key === targetKey);
    if (!target) throw new OperatorError('ORGANIZATION_TARGET_NOT_FOUND', 'Recovery target is not in the owning program.');
    const returnedMissionId = validUuid(input.returnedMissionId, 'returnedMissionId');
    const intentId = compensationIntentId(program.id, 'reconcile-untrusted-team-identity', returnedMissionId);
    return await this.#adjudicator.review({
      intentId, programId: program.id, targetKey,
      expectedMissionId: stableOrganizationMissionId(program.id, targetKey),
      returnedMissionId, operatorId: input.operatorId, providerClaim: input.providerClaim
    });
  }

  async #assertNoPendingCompensation(programId: string): Promise<void> {
    const pending = (await this.#compensations.pending('organization')).filter((item) => item.ownerId === programId);
    if (pending.length > 0) {
      throw new OperatorError('ORGANIZATION_RECOVERY_REQUIRED', 'Organization rollout has unresolved durable compensation work and cannot advance.', {
        retryable: true,
        details: { pending: pending.map((item) => ({ operation: item.operation, targetId: item.targetId, subjectKey: item.subjectKey })) }
      });
    }
  }

  #compensationWasCommitted(
    intent: DurableCompensationIntent,
    program: OrganizationProgram | undefined,
    target: OrganizationTarget | undefined
  ): boolean {
    if (!program || !target || target.missionId !== intent.targetId ||
        intent.targetId !== stableOrganizationMissionId(program.id, target.key)) return false;
    return intent.operation === 'cancel-team-mission' || intent.operation === 'pause-team-mission';
  }

  async #startWave(program: OrganizationProgram, waveIndex: number, transaction: OrganizationMutationTransaction): Promise<void> {
    const wave = program.waves[waveIndex];
    if (!wave) throw new OperatorError('ORGANIZATION_WAVE_INVALID', 'Rollout wave was not found.');
    if (wave.targetKeys.length > program.policy.maxParallel) throw new OperatorError('ORGANIZATION_PARALLEL_LIMIT', 'Wave exceeds configured parallel blast-radius limit.');
    for (const target of program.targets.filter((item) => item.wave === waveIndex)) {
      if (target.missionId) continue;
      const plannedMissionId = stableOrganizationMissionId(program.id, target.key);
      const compensationId = compensationIntentId(program.id, 'cancel-team-mission', plannedMissionId);
      await this.#compensations.prepare({
        id: compensationId,
        ownerKind: 'organization',
        ownerId: program.id,
        operation: 'cancel-team-mission',
        targetId: plannedMissionId,
        subjectKey: target.key
      });
      const mission = await this.#teams.submit({
        missionId: plannedMissionId,
        objective: `${program.objective} [${target.key}]`,
        workItems: target.workItems,
        budget: program.policy.teamBudget
      });
      if (mission.id !== plannedMissionId) {
        // A child that disregards its write-ahead identity is an untrusted
        // outcome. Preserve the original intent and quarantine the unverified
        // returned identity; never cancel work we cannot prove we created.
        await this.#compensations.prepare({
          id: compensationIntentId(program.id, 'reconcile-untrusted-team-identity', mission.id),
          ownerKind: 'organization',
          ownerId: program.id,
          operation: 'reconcile-untrusted-team-identity',
          targetId: mission.id,
          subjectKey: target.key
        });
        throw new OperatorError('ORGANIZATION_MISSION_ID_CONFLICT', 'Child mission identity differs from its write-ahead recovery contract.');
      }
      await this.#compensations.confirm(compensationId);
      const durableCompensationId = compensationId;
      transaction.onCommit(async () => { await this.#compensations.complete(durableCompensationId); });
      transaction.onRollback(async () => {
        try {
          const cancelled = await this.#teams.cancel(mission.id);
          if (cancelled.state === 'CANCELLED') await this.#compensations.complete(durableCompensationId);
        } catch {}
      });
      const started = await this.#teams.start(mission.id);
      if (started.state !== 'RUNNING') throw new OperatorError('ORGANIZATION_CHILD_START_UNCONFIRMED', 'Child mission did not confirm running state.');
      target.missionId = mission.id;
      target.state = 'RUNNING';
      target.updatedAt = this.#clock().toISOString();
    }
    wave.state = 'RUNNING';
  }

  async #mutate(
    id: string,
    mutate: (program: OrganizationProgram, transaction: OrganizationMutationTransaction) => Promise<void> | void
  ): Promise<OrganizationProgram> {
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const program = state.programs.find((item) => item.id === id);
      if (!program) throw new OperatorError('ORGANIZATION_PROGRAM_NOT_FOUND', 'Organization program was not found.');
      const rollbackCallbacks: Array<() => Promise<void> | void> = [];
      const commitCallbacks: Array<() => Promise<void> | void> = [];
      const transaction: OrganizationMutationTransaction = {
        onRollback(callback) { rollbackCallbacks.push(callback); },
        onCommit(callback) { commitCallbacks.push(callback); }
      };
      try {
        await mutate(program, transaction);
        validateProgram(program);
        await this.#write(state);
        for (const commit of commitCallbacks) {
          try { await commit(); } catch { /* durable intent remains for restart cleanup */ }
        }
        return structuredClone(program);
      } catch (error) {
        for (const rollback of rollbackCallbacks.reverse()) {
          try { await rollback(); } catch { /* durable intent remains pending */ }
        }
        throw error;
      }
    }));
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
    if (target.controlFailure !== undefined) {
      if (!['pause', 'cancel'].includes(target.controlFailure.operation)) throw corrupt('Target control failure operation is invalid.');
      boundedKey(target.controlFailure.code, 'control failure code');
      boundedText(target.controlFailure.message, 64 * 1024, 'control failure message');
      validIso(target.controlFailure.at, 'control failure timestamp');
    }
    validIso(target.updatedAt, 'target updatedAt');
  }
  for (const wave of program.waves) {
    boundedInteger(wave.index, 0, program.waves.length - 1, 'wave index');
    if (!Array.isArray(wave.targetKeys) || wave.targetKeys.length < 1 || wave.targetKeys.some((key) => !targetKeys.has(key))) throw corrupt('Wave targets are invalid.');
    if (!['PENDING', 'RUNNING', 'VERIFIED', 'FAILED'].includes(wave.state)) throw corrupt('Wave state is invalid.');
    if (wave.verificationDigest !== undefined) shaDigest(wave.verificationDigest, 'verificationDigest');
    if (wave.promotedAt !== undefined) validIso(wave.promotedAt, 'promotedAt');
    if (wave.promotionDigest !== undefined) shaDigest(wave.promotionDigest, 'promotionDigest');
    if (wave.promotionDigest !== undefined && wave.verificationDigest !== undefined && wave.promotionDigest !== wave.verificationDigest) {
      throw corrupt('Wave promotion digest must be bound to the wave verification digest.');
    }
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

function controlFailure(operation: 'pause' | 'cancel', error: unknown, now: Date): NonNullable<OrganizationTarget['controlFailure']> {
  return {
    operation,
    code: typeof (error as any)?.code === 'string' ? boundedKey((error as any).code, 'control failure code') : 'ORGANIZATION_CHILD_CONTROL_FAILED',
    message: boundedText(error instanceof Error ? error.message : String(error), 64 * 1024, 'control failure message'),
    at: now.toISOString()
  };
}
