import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { actionHash, canonicalJson } from './action-identity.ts';
import { createDurableStateBytes, readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { canonicalResourceKeys } from './resource-identity.ts';
import type { ActionRequest, ActionResult, IntentBinding, ProviderReconciliationResult } from './types.ts';
import { validIntentBinding } from './intent-registry.ts';
import { kernelVerificationDigest, verifyActionOutcome } from './action-verification.ts';

export type ActionJournalState =
  | 'PREPARED'
  | 'DEFERRED'
  | 'DISPATCHED'
  | 'OBSERVED'
  | 'UNCERTAIN'
  | 'RECONCILED'
  | 'COMPLETED';

export interface ActionJournalTransition {
  seq: number;
  state: ActionJournalState;
  at: string;
  provider?: string;
  resultDigest?: string;
  verificationDigest?: string;
  reconciliationStatus?: ProviderReconciliationResult['status'];
}

export interface ActionJournalEntry {
  version: 1;
  actionId: string;
  actionDigest: string;
  ownerKind: string;
  ownerId: string;
  capability: string;
  risk: ActionRequest['risk'];
  intent?: IntentBinding;
  resourceKeys: string[];
  generation: number;
  state: ActionJournalState;
  transitions: ActionJournalTransition[];
  createdAt: string;
  updatedAt: string;
}

interface JournalState {
  version: 1;
  entries: ActionJournalEntry[];
}

interface StagedCompletedResult {
  version: 1;
  actionId: string;
  actionDigest: string;
  journalGeneration: number;
  capability: string;
  verificationDigest: string;
  resultDigest: string;
  result: ActionResult;
}

export type ActionCompletionFaultPoint =
  | 'after_result_staged'
  | 'after_journal_completed'
  | 'after_result_published';

const MAX_ENTRIES = 20_000;
const MAX_TRANSITIONS = 64;
const TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
const STORE_OPTIONS = {
  maxBytes: 64 * 1024 * 1024,
  errorCode: 'ACTION_JOURNAL_CORRUPT',
  invalidMessage: 'Action transition journal is invalid.'
} as const;
const RESULT_OPTIONS = {
  maxBytes: 16 * 1024 * 1024,
  errorCode: 'ACTION_JOURNAL_RESULT_CORRUPT',
  invalidMessage: 'Completed action replay result is invalid.'
} as const;
const STAGED_RESULT_OPTIONS = {
  maxBytes: RESULT_OPTIONS.maxBytes + 128 * 1024,
  errorCode: 'ACTION_JOURNAL_RESULT_CORRUPT',
  invalidMessage: 'Staged completed action result is invalid.'
} as const;

export class ActionTransitionJournal {
  #file: string;
  #resultDir: string;
  #clock: () => Date;
  #completionFault?: (point: ActionCompletionFaultPoint, actionId: string) => void | Promise<void>;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: {
    clock?: () => Date;
    completionFault?: (point: ActionCompletionFaultPoint, actionId: string) => void | Promise<void>;
  } = {}) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'action-transitions.json');
    this.#resultDir = path.join(root, 'action-results');
    this.#clock = options.clock ?? (() => new Date());
    this.#completionFault = options.completionFault;
  }

  async prepare(input: {
    action: ActionRequest;
    ownerKind: string;
    ownerId: string;
    resourceKeys: string[];
  }): Promise<ActionJournalEntry> {
    return await this.#mutate(async (state, now) => {
      const prunedActionIds = pruneTerminal(state, now.getTime());
      for (const actionId of prunedActionIds) {
        try {
          await fs.rm(this.#resultFile(actionId), { force: true });
          await fs.rm(this.#stagedResultFile(actionId), { force: true });
        } catch (error) {
          throw new OperatorError(
            'ACTION_JOURNAL_RESULT_CLEANUP_FAILED',
            `Could not reclaim retained result for action ${actionId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const digest = actionHash(input.action);
      const existing = state.entries.find((entry) => entry.actionId === input.action.id);
      if (existing) {
        if (existing.actionDigest !== digest || existing.ownerKind !== input.ownerKind || existing.ownerId !== input.ownerId
          || existing.capability !== input.action.capability || existing.risk !== input.action.risk
          || canonicalJson(existing.intent ?? null) !== canonicalJson(input.action.intent ?? null)
          || canonicalJson(canonicalResourceKeys(existing.resourceKeys)) !== canonicalJson(canonicalResourceKeys(uniqueKeys(input.resourceKeys)))) {
          throw new OperatorError('ACTION_JOURNAL_ID_CONFLICT', 'Action id is already bound to a different durable execution identity.');
        }
        if (existing.state === 'COMPLETED' && input.action.risk === 'read') {
          const at = now.toISOString();
          existing.generation = (existing.generation ?? 1) + 1;
          existing.state = 'PREPARED';
          existing.transitions = [{ seq: 1, state: 'PREPARED', at }];
          existing.updatedAt = at;
        }
        return existing;
      }
      if (state.entries.length >= MAX_ENTRIES) {
        throw new OperatorError('ACTION_JOURNAL_LIMIT', 'Action transition journal has reached its active/retained entry limit.');
      }
      const at = now.toISOString();
      const entry: ActionJournalEntry = {
        version: 1,
        actionId: bounded(input.action.id, 512, 'actionId'),
        actionDigest: digest,
        ownerKind: bounded(input.ownerKind, 128, 'ownerKind'),
        ownerId: bounded(input.ownerId, 512, 'ownerId'),
        capability: bounded(input.action.capability, 256, 'capability'),
        risk: input.action.risk,
        ...(input.action.intent ? { intent: validIntentBinding(input.action.intent) } : {}),
        resourceKeys: uniqueKeys(input.resourceKeys),
        generation: 1,
        state: 'PREPARED',
        transitions: [{ seq: 1, state: 'PREPARED', at }],
        createdAt: at,
        updatedAt: at
      };
      state.entries.push(entry);
      state.entries.sort((a, b) => a.actionId.localeCompare(b.actionId));
      return entry;
    });
  }

  async markDispatched(actionId: string, provider?: string): Promise<ActionJournalEntry> {
    return await this.#transition(actionId, 'DISPATCHED', provider ? { provider: bounded(provider, 256, 'provider') } : {});
  }

  async defer(actionId: string, result: ActionResult): Promise<ActionJournalEntry> {
    return await this.#transition(actionId, 'DEFERRED', {
      provider: bounded(result.provider, 256, 'provider'),
      resultDigest: digest(result)
    });
  }

  async observe(actionId: string, result: ActionResult): Promise<ActionJournalEntry> {
    const resultDigest = digest(result);
    const provider = bounded(result.provider, 256, 'provider');
    const state: ActionJournalState = result.ok
      ? 'OBSERVED'
      : result.error?.sideEffectState === 'uncertain'
        ? 'UNCERTAIN'
        : result.error?.executionPhase === 'pre_dispatch' || result.error?.sideEffectState === 'none'
          ? 'PREPARED'
          : 'COMPLETED';
    return await this.#transition(actionId, state, { provider, resultDigest });
  }

  async reconcile(actionId: string, reconciliation: ProviderReconciliationResult): Promise<ActionJournalEntry> {
    const resultDigest = reconciliation.result ? digest(reconciliation.result) : undefined;
    const next: ActionJournalState = reconciliation.status === 'uncertain' ? 'UNCERTAIN' : 'RECONCILED';
    return await this.#transition(actionId, next, {
      ...(resultDigest ? { resultDigest } : {}),
      reconciliationStatus: reconciliation.status
    });
  }

  async complete(actionId: string, verificationDigest: string, result?: ActionResult): Promise<ActionJournalEntry> {
    const digestValue = sha(verificationDigest, 'verificationDigest');
    const current = await this.inspect(actionId);
    if (current.risk === 'read') {
      return await this.#transition(actionId, 'COMPLETED', { verificationDigest: digestValue });
    }
    if (!result || !result.ok || result.capability !== current.capability) {
      throw new OperatorError('ACTION_JOURNAL_RESULT_INVALID', 'A successful matching mutation result is required for durable completion.');
    }
    const safeResult = validateReplayResult(result, current.capability);
    const embeddedVerification = kernelVerificationDigest(safeResult);
    if (!embeddedVerification || embeddedVerification !== digestValue) {
      throw new OperatorError('ACTION_JOURNAL_RESULT_INVALID', 'Mutation completion result is not bound to the supplied kernel verification digest.');
    }
    const resultDigest = digest(safeResult);
    const staged: StagedCompletedResult = {
      version: 1,
      actionId: current.actionId,
      actionDigest: current.actionDigest,
      journalGeneration: current.generation,
      capability: current.capability,
      verificationDigest: digestValue,
      resultDigest,
      result: safeResult
    };
    const completed = await this.#mutate(async (state, now) => {
      const entry = findEntry(state, actionId);
      assertStageMatchesEntry(staged, entry);
      if (entry.state === 'COMPLETED') {
        assertStageMatchesCompletion(staged, entry);
        return entry;
      }
      if (entry.state !== 'OBSERVED' && entry.state !== 'RECONCILED') {
        throw new OperatorError('ACTION_JOURNAL_TRANSITION_INVALID', `Cannot complete mutation from action journal state ${entry.state}.`);
      }
      await this.#writeStagedResult(staged);
      await this.#completionFault?.('after_result_staged', entry.actionId);
      applyTransition(entry, 'COMPLETED', now, { verificationDigest: digestValue, resultDigest });
      return entry;
    });
    await this.#completionFault?.('after_journal_completed', completed.actionId);
    await this.#publishStagedResult(staged);
    return completed;
  }

  async recoverPendingCompletion(actionIdInput: string, action?: ActionRequest): Promise<ActionJournalEntry> {
    const actionId = bounded(actionIdInput, 512, 'actionId');
    let staged = await this.#readStagedResult(actionId);
    if (!staged) {
      const entry = await this.inspect(actionId);
      if (entry.state !== 'COMPLETED' && (entry.state === 'OBSERVED' || entry.state === 'RECONCILED')) {
        staged = await this.#readLegacyOrphanResult(entry, action);
      }
      if (!staged) return entry;
    }
    const completed = await this.#mutate((state, now) => {
      const entry = findEntry(state, actionId);
      assertStageMatchesEntry(staged!, entry);
      if (entry.state === 'COMPLETED') {
        assertStageMatchesCompletion(staged!, entry);
        return entry;
      }
      if (entry.state !== 'OBSERVED' && entry.state !== 'RECONCILED') {
        throw new OperatorError('ACTION_JOURNAL_COMPLETION_CONFLICT', `Staged completion conflicts with journal state ${entry.state}.`);
      }
      applyTransition(entry, 'COMPLETED', now, {
        verificationDigest: staged!.verificationDigest,
        resultDigest: staged!.resultDigest
      });
      return entry;
    });
    await this.#publishStagedResult(staged);
    return completed;
  }

  async replayCompleted(actionIdInput: string): Promise<ActionResult | undefined> {
    let entry = await this.inspect(actionIdInput);
    if (entry.risk !== 'read') entry = await this.recoverPendingCompletion(entry.actionId);
    if (entry.state !== 'COMPLETED' || entry.risk === 'read') return undefined;
    const transition = [...entry.transitions].reverse().find((item) =>
      item.state === 'COMPLETED' && item.verificationDigest && item.resultDigest
    );
    if (!transition?.resultDigest) return undefined;
    try {
      const parsed = JSON.parse(await readDurableStateText(this.#resultFile(entry.actionId), RESULT_OPTIONS));
      const result = validateReplayResult(parsed, entry.capability);
      if (digest(result) !== transition.resultDigest) {
        throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Persisted completed action result digest does not match the journal.');
      }
      return structuredClone(result);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Persisted completed action result could not be read.');
    }
  }

  async inspect(actionIdInput: string): Promise<ActionJournalEntry> {
    await this.#serial;
    const actionId = bounded(actionIdInput, 512, 'actionId');
    const state = await this.#read();
    const entry = state.entries.find((item) => item.actionId === actionId);
    if (!entry) throw new OperatorError('ACTION_JOURNAL_NOT_FOUND', 'Action journal entry was not found.');
    return structuredClone(entry);
  }

  async list(limitInput = 100): Promise<ActionJournalEntry[]> {
    await this.#serial;
    const limit = integer(limitInput, 1, 1000, 'limit');
    const state = await this.#read();
    return state.entries.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async unresolvedMutations(): Promise<ActionJournalEntry[]> {
    await this.#serial;
    const state = await this.#read();
    return state.entries
      .filter((entry) => entry.risk !== 'read' && (entry.state === 'DISPATCHED' || entry.state === 'UNCERTAIN'))
      .sort((a, b) => a.actionId.localeCompare(b.actionId))
      .map((entry) => structuredClone(entry));
  }

  async #transition(
    actionIdInput: string,
    next: ActionJournalState,
    metadata: Omit<ActionJournalTransition, 'seq' | 'state' | 'at'>
  ): Promise<ActionJournalEntry> {
    return await this.#mutate((state, now) => {
      const entry = findEntry(state, actionIdInput);
      applyTransition(entry, next, now, metadata);
      return entry;
    });
  }

  async #writeStagedResult(staged: StagedCompletedResult): Promise<void> {
    const resultText = JSON.stringify(staged.result);
    if (Buffer.byteLength(resultText, 'utf8') > RESULT_OPTIONS.maxBytes) {
      throw new OperatorError('ACTION_JOURNAL_RESULT_TOO_LARGE', 'Completed mutation result is too large for durable replay.');
    }
    const stagedText = JSON.stringify(staged);
    try {
      await createDurableStateBytes(this.#stagedResultFile(staged.actionId), Buffer.from(stagedText, 'utf8'), STAGED_RESULT_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const persisted = await this.#readStagedResult(staged.actionId);
    if (!persisted || canonicalJson(persisted) !== canonicalJson(staged)) {
      throw new OperatorError('ACTION_JOURNAL_COMPLETION_CONFLICT', 'An immutable staged completion already exists with different lineage.');
    }
  }

  async #publishStagedResult(staged: StagedCompletedResult): Promise<void> {
    const resultText = JSON.stringify(staged.result);
    try {
      await createDurableStateBytes(this.#resultFile(staged.actionId), Buffer.from(resultText, 'utf8'), RESULT_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const persisted = validateReplayResult(JSON.parse(await readDurableStateText(this.#resultFile(staged.actionId), RESULT_OPTIONS)), staged.capability);
    if (digest(persisted) !== staged.resultDigest) {
      throw new OperatorError('ACTION_JOURNAL_COMPLETION_CONFLICT', 'An immutable published result already exists with different lineage.');
    }
    await this.#completionFault?.('after_result_published', staged.actionId);
    await fs.rm(this.#stagedResultFile(staged.actionId), { force: true });
  }

  async #readStagedResult(actionId: string): Promise<StagedCompletedResult | undefined> {
    try {
      return validateStagedResult(JSON.parse(await readDurableStateText(this.#stagedResultFile(actionId), STAGED_RESULT_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof OperatorError) throw error;
      throw resultCorrupt('Staged completion could not be read.');
    }
  }

  async #readLegacyOrphanResult(entry: ActionJournalEntry, action?: ActionRequest): Promise<StagedCompletedResult | undefined> {
    try {
      const result = validateReplayResult(JSON.parse(await readDurableStateText(this.#resultFile(entry.actionId), RESULT_OPTIONS)), entry.capability);
      const verificationDigest = kernelVerificationDigest(result);
      if (!verificationDigest || !action || action.id !== entry.actionId || actionHash(action) !== entry.actionDigest) {
        throw resultCorrupt('Legacy orphan result has no exact action and kernel verification lineage.');
      }
      const evidenceIndex = result.evidence.map((item) => item.kind === 'kernel_verification'
        && item.status === 'pass'
        && item.data?.verificationDigest === verificationDigest).lastIndexOf(true);
      if (evidenceIndex < 0) throw resultCorrupt('Legacy orphan kernel verification evidence is invalid.');
      const resultBeforeKernelVerification = {
        ...result,
        evidence: result.evidence.filter((_item, index) => index !== evidenceIndex)
      };
      const receipt = verifyActionOutcome({ action, result: resultBeforeKernelVerification, journal: entry });
      if (!receipt.verified || receipt.digest !== verificationDigest) {
        throw resultCorrupt('Legacy orphan kernel verification lineage could not be reproduced.');
      }
      const staged: StagedCompletedResult = {
        version: 1,
        actionId: entry.actionId,
        actionDigest: entry.actionDigest,
        journalGeneration: entry.generation,
        capability: entry.capability,
        verificationDigest,
        resultDigest: digest(result),
        result
      };
      await this.#writeStagedResult(staged);
      return staged;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  #resultFile(actionId: string): string {
    const key = crypto.createHash('sha256').update(actionId, 'utf8').digest('hex');
    return path.join(this.#resultDir, `${key}.json`);
  }

  #stagedResultFile(actionId: string): string {
    const key = crypto.createHash('sha256').update(actionId, 'utf8').digest('hex');
    return path.join(this.#resultDir, `${key}.staged.json`);
  }

  async #read(): Promise<JournalState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ACTION_JOURNAL_CORRUPT', 'Action transition journal could not be read.');
    }
  }

  async #mutate<T>(fn: (state: JournalState, now: Date) => T | Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      output = await fn(state, this.#clock());
      validateState(state);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }
}

function allowedTransition(current: ActionJournalState, next: ActionJournalState): boolean {
  if (current === next) return true;
  if (current === 'PREPARED') return next === 'DEFERRED' || next === 'DISPATCHED' || next === 'COMPLETED';
  if (current === 'DEFERRED') return next === 'DEFERRED' || next === 'DISPATCHED' || next === 'COMPLETED';
  if (current === 'DISPATCHED') return next === 'PREPARED' || next === 'OBSERVED' || next === 'UNCERTAIN' || next === 'RECONCILED' || next === 'COMPLETED';
  if (current === 'OBSERVED') return next === 'RECONCILED' || next === 'COMPLETED' || next === 'UNCERTAIN';
  if (current === 'UNCERTAIN') return next === 'RECONCILED' || next === 'UNCERTAIN';
  if (current === 'RECONCILED') return next === 'DISPATCHED' || next === 'COMPLETED' || next === 'UNCERTAIN';
  return false;
}

function findEntry(state: JournalState, actionIdInput: string): ActionJournalEntry {
  const actionId = bounded(actionIdInput, 512, 'actionId');
  const entry = state.entries.find((item) => item.actionId === actionId);
  if (!entry) throw new OperatorError('ACTION_JOURNAL_NOT_FOUND', 'Action journal entry was not found.');
  return entry;
}

function applyTransition(
  entry: ActionJournalEntry,
  next: ActionJournalState,
  now: Date,
  metadata: Omit<ActionJournalTransition, 'seq' | 'state' | 'at'>
): void {
  if (!allowedTransition(entry.state, next)) {
    if (entry.state === next) return;
    throw new OperatorError('ACTION_JOURNAL_TRANSITION_INVALID', `Cannot transition action journal from ${entry.state} to ${next}.`);
  }
  // A retry of exactly the last transition is not new evidence. Keeping a
  // second copy would eventually exhaust the bounded journal on safe retries.
  // Distinct metadata remains an explicit new observation and is preserved.
  const last = entry.transitions.at(-1)!;
  if (entry.state === next && canonicalJson({
    provider: last.provider,
    resultDigest: last.resultDigest,
    verificationDigest: last.verificationDigest,
    reconciliationStatus: last.reconciliationStatus
  }) === canonicalJson(metadata)) return;
  if (entry.transitions.length >= MAX_TRANSITIONS) {
    throw new OperatorError('ACTION_JOURNAL_TRANSITION_LIMIT', 'Action journal transition history is unexpectedly large.');
  }
  const at = now.toISOString();
  entry.state = next;
  entry.updatedAt = at;
  entry.transitions.push({ seq: entry.transitions.length + 1, state: next, at, ...metadata });
}

function pruneTerminal(state: JournalState, now: number): string[] {
  const removed: string[] = [];
  state.entries = state.entries.filter((entry) => {
    const retain = entry.state !== 'COMPLETED' || Date.parse(entry.updatedAt) > now - TERMINAL_RETENTION_MS;
    if (!retain) removed.push(entry.actionId);
    return retain;
  });
  return removed;
}

function validateState(input: unknown): JournalState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const state = input as JournalState;
  if (state.version !== 1 || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const entry of state.entries) {
    if (entry.version !== 1) throw corrupt('Entry version is invalid.');
    bounded(entry.actionId, 512, 'actionId');
    sha(entry.actionDigest, 'actionDigest');
    if (ids.has(entry.actionId)) throw corrupt('Action ids must be unique.');
    ids.add(entry.actionId);
    bounded(entry.ownerKind, 128, 'ownerKind');
    bounded(entry.ownerId, 512, 'ownerId');
    bounded(entry.capability, 256, 'capability');
    if (!['read','write','external','system','destructive'].includes(entry.risk)) throw corrupt('Action risk is invalid.');
    if (entry.intent) validIntentBinding(entry.intent);
    entry.resourceKeys = uniqueKeys(entry.resourceKeys);
    entry.generation = entry.generation === undefined ? 1 : integer(entry.generation, 1, Number.MAX_SAFE_INTEGER, 'generation');
    if (!['PREPARED','DEFERRED','DISPATCHED','OBSERVED','UNCERTAIN','RECONCILED','COMPLETED'].includes(entry.state)) throw corrupt('Entry state is invalid.');
    if (!Array.isArray(entry.transitions) || entry.transitions.length < 1 || entry.transitions.length > MAX_TRANSITIONS) throw corrupt('Transition history is invalid.');
    if (entry.transitions[0]?.state !== 'PREPARED') throw corrupt('Transition history must begin in PREPARED.');
    let previousAt = -Infinity;
    for (let index = 0; index < entry.transitions.length; index += 1) {
      const transition = entry.transitions[index]!;
      if (transition.seq !== index + 1) throw corrupt('Transition sequence is invalid.');
      if (!['PREPARED','DEFERRED','DISPATCHED','OBSERVED','UNCERTAIN','RECONCILED','COMPLETED'].includes(transition.state)) throw corrupt('Transition state is invalid.');
      const transitionAt = Date.parse(iso(transition.at));
      if (transitionAt < previousAt) throw corrupt('Transition timestamps must be nondecreasing.');
      previousAt = transitionAt;
      if (transition.provider !== undefined) bounded(transition.provider, 256, 'provider');
      if (transition.resultDigest !== undefined) sha(transition.resultDigest, 'resultDigest');
      if (transition.verificationDigest !== undefined) sha(transition.verificationDigest, 'verificationDigest');
      if (transition.reconciliationStatus !== undefined && !['completed','not_applied','uncertain'].includes(transition.reconciliationStatus)) throw corrupt('Reconciliation status is invalid.');
      if (index > 0 && !allowedTransition(entry.transitions[index - 1]!.state, transition.state)) {
        throw corrupt(`Transition ${entry.transitions[index - 1]!.state} -> ${transition.state} is illegal.`);
      }
      validateTransitionMetadata(transition, index === 0);
    }
    if (entry.transitions.at(-1)?.state !== entry.state) throw corrupt('Entry state does not match its latest transition.');
    const createdAt = Date.parse(iso(entry.createdAt));
    const updatedAt = Date.parse(iso(entry.updatedAt));
    if (createdAt > Date.parse(entry.transitions[0]!.at)) throw corrupt('Entry creation timestamp is after its current generation.');
    if (updatedAt !== Date.parse(entry.transitions.at(-1)!.at)) throw corrupt('Entry update timestamp does not match its latest transition.');
  }
  return state;
}

function validateTransitionMetadata(transition: ActionJournalTransition, initial: boolean): void {
  if (initial && (transition.provider !== undefined || transition.resultDigest !== undefined
    || transition.verificationDigest !== undefined || transition.reconciliationStatus !== undefined)) {
    throw corrupt('Initial PREPARED transition cannot contain execution metadata.');
  }
  if (transition.verificationDigest !== undefined && transition.state !== 'COMPLETED') {
    throw corrupt('Verification metadata is only valid on COMPLETED transitions.');
  }
  if (transition.reconciliationStatus !== undefined && transition.state !== 'RECONCILED' && transition.state !== 'UNCERTAIN') {
    throw corrupt('Reconciliation metadata is attached to an invalid transition state.');
  }
  if (transition.state === 'DEFERRED' || transition.state === 'OBSERVED') {
    if (!transition.provider || !transition.resultDigest) throw corrupt(`${transition.state} transition is missing provider result metadata.`);
  }
  if (transition.state === 'PREPARED' && !initial && (!transition.provider || !transition.resultDigest)) {
    throw corrupt('A retried PREPARED transition is missing its observed provider result.');
  }
  if (transition.state === 'UNCERTAIN') {
    const observed = transition.provider !== undefined && transition.resultDigest !== undefined
      && transition.reconciliationStatus === undefined;
    const reconciled = transition.provider === undefined && transition.reconciliationStatus === 'uncertain';
    if (!observed && !reconciled) throw corrupt('UNCERTAIN transition metadata is inconsistent with observation or reconciliation.');
  }
  if (transition.state === 'RECONCILED'
    && transition.reconciliationStatus !== 'completed'
    && transition.reconciliationStatus !== 'not_applied') {
    throw corrupt('RECONCILED transition must record a definitive reconciliation status.');
  }
  if (transition.state === 'COMPLETED') {
    const verified = transition.verificationDigest !== undefined;
    const terminalObservation = transition.provider !== undefined && transition.resultDigest !== undefined;
    if (!verified && !terminalObservation) throw corrupt('COMPLETED transition lacks verification or terminal observation metadata.');
  }
}

function validateReplayResult(input: unknown, expectedCapability?: string): ActionResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay result must be an object.');
  }
  const raw = input as ActionResult;
  if (raw.ok !== true) throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay result must be successful.');
  const capability = bounded(raw.capability, 256, 'result.capability');
  if (expectedCapability && capability !== expectedCapability) {
    throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay capability does not match its journal entry.');
  }
  bounded(raw.provider, 256, 'result.provider');
  if (!Array.isArray(raw.evidence) || raw.evidence.length > 10_000) {
    throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay evidence is invalid.');
  }
  for (const item of raw.evidence) {
    if (!item || typeof item !== 'object') throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay evidence item is invalid.');
    bounded(item.kind, 256, 'evidence.kind');
    if (!['pass','fail','info'].includes(item.status)) throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay evidence status is invalid.');
    bounded(item.message, 64 * 1024, 'evidence.message');
    iso(item.timestamp);
  }
  if (!Number.isFinite(raw.durationMs) || raw.durationMs < 0) {
    throw new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', 'Completed action replay duration is invalid.');
  }
  return structuredClone(raw);
}

function validateStagedResult(input: unknown): StagedCompletedResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw resultCorrupt('Staged completion must be an object.');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => ![
    'version', 'actionId', 'actionDigest', 'journalGeneration', 'capability',
    'verificationDigest', 'resultDigest', 'result'
  ].includes(key)) || raw.version !== 1) {
    throw resultCorrupt('Staged completion shape is invalid.');
  }
  const capability = bounded(raw.capability, 256, 'staged.capability');
  const result = validateReplayResult(raw.result, capability);
  const staged: StagedCompletedResult = {
    version: 1,
    actionId: bounded(raw.actionId, 512, 'staged.actionId'),
    actionDigest: sha(raw.actionDigest, 'staged.actionDigest'),
    journalGeneration: integer(raw.journalGeneration, 1, Number.MAX_SAFE_INTEGER, 'staged.journalGeneration'),
    capability,
    verificationDigest: sha(raw.verificationDigest, 'staged.verificationDigest'),
    resultDigest: sha(raw.resultDigest, 'staged.resultDigest'),
    result
  };
  if (digest(result) !== staged.resultDigest) throw resultCorrupt('Staged result digest is invalid.');
  const embeddedVerification = kernelVerificationDigest(result);
  if (!embeddedVerification || embeddedVerification !== staged.verificationDigest) {
    throw resultCorrupt('Staged verification lineage does not match the result evidence.');
  }
  return staged;
}

function assertStageMatchesEntry(staged: StagedCompletedResult, entry: ActionJournalEntry): void {
  const recordedProvider = [...entry.transitions].reverse().find((transition) => transition.provider)?.provider;
  if (staged.actionId !== entry.actionId || staged.actionDigest !== entry.actionDigest
    || staged.journalGeneration !== entry.generation || staged.capability !== entry.capability
    || !recordedProvider || staged.result.provider !== recordedProvider) {
    throw new OperatorError('ACTION_JOURNAL_COMPLETION_CONFLICT', 'Staged completion does not match the journal action lineage.');
  }
}

function assertStageMatchesCompletion(staged: StagedCompletedResult, entry: ActionJournalEntry): void {
  const completion = [...entry.transitions].reverse().find((transition) => transition.state === 'COMPLETED');
  if (!completion?.verificationDigest || !completion.resultDigest
    || completion.verificationDigest !== staged.verificationDigest
    || completion.resultDigest !== staged.resultDigest) {
    throw new OperatorError('ACTION_JOURNAL_COMPLETION_CONFLICT', 'Staged completion does not match the completed journal transition.');
  }
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
function uniqueKeys(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 5000) throw new OperatorError('ACTION_JOURNAL_INPUT_INVALID', 'Resource keys are invalid.');
  const values = [...new Set(input.map((value, index) => bounded(value, 1024, `resourceKeys[${index}]`)))].sort();
  return values;
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (value.length < 1 || value.length > max || value.includes('\0')) throw new OperatorError('ACTION_JOURNAL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function sha(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('ACTION_JOURNAL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function iso(input: unknown): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw corrupt('Timestamp is invalid.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('ACTION_JOURNAL_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function corrupt(message: string): OperatorError {
  return new OperatorError('ACTION_JOURNAL_CORRUPT', `Action transition journal is invalid. ${message}`);
}

function resultCorrupt(message: string): OperatorError {
  return new OperatorError('ACTION_JOURNAL_RESULT_CORRUPT', `Completed action replay result is invalid. ${message}`);
}
