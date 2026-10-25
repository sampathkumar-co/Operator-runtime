import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { createDurableStateBytes, readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { ModelCallBudgetLedger } from './bounded-model-goal-inference.ts';

const OPTIONS = {
  maxBytes: 1024 * 1024,
  errorCode: 'TASK_MODEL_BUDGET_LEDGER_CORRUPT',
  invalidMessage: 'Stored model budget ledger is invalid or unsafe.'
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Status = 'RESERVED' | 'VALIDATED_PROPOSAL' | 'UNKNOWN_SPEND';
export interface DurableModelBudgetLimits {
  maxCalls: number;
  maxOutputTokens: number;
  maxCostMicros: number;
}
interface RecordEntry {
  reservationId: string;
  callId: string;
  modelId: string;
  maxOutputTokens: number;
  maxCostMicros: number;
  status: Status;
}
interface BudgetFile {
  schemaVersion: 1;
  limits: DurableModelBudgetLimits;
  reservations: RecordEntry[];
}

function denied(code: string, message: string): never {
  throw new OperatorError(code, message);
}
function allowedInt(value: unknown, low: number, high: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high;
}
function validLimits(value: unknown): value is DurableModelBudgetLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  return Object.keys(x).sort().join(',') === 'maxCalls,maxCostMicros,maxOutputTokens' &&
    allowedInt(x.maxCalls, 1, 1000) &&
    allowedInt(x.maxOutputTokens, 64, 4_096_000) &&
    allowedInt(x.maxCostMicros, 0, 1_000_000_000);
}
function exactKeys(x: unknown, keys: string[]): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) &&
    Object.keys(x).sort().join(',') === [...keys].sort().join(',');
}
function validRecord(input: unknown): input is RecordEntry {
  if (!exactKeys(input, ['reservationId','callId','modelId','maxOutputTokens','maxCostMicros','status'])) return false;
  return UUID.test(String(input.reservationId)) && UUID.test(String(input.callId)) &&
    typeof input.modelId === 'string' && input.modelId.length >= 1 &&
    input.modelId.length <= 128 && input.modelId.trim() === input.modelId &&
    allowedInt(input.maxOutputTokens, 64, 4096) &&
    allowedInt(input.maxCostMicros, 0, 2_000_000) &&
    ['RESERVED','VALIDATED_PROPOSAL','UNKNOWN_SPEND'].includes(String(input.status));
}
function validateFile(input: unknown, expected: DurableModelBudgetLimits): BudgetFile {
  if (!exactKeys(input, ['schemaVersion', 'limits', 'reservations']) ||
      input.schemaVersion !== 1 || !validLimits(input.limits) ||
      !Array.isArray(input.reservations) || input.reservations.length > expected.maxCalls) {
    denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT', 'Stored model budget shape or counts are invalid.');
  }
  const file = input as unknown as BudgetFile;
  if (JSON.stringify(file.limits) !== JSON.stringify(expected)) {
    denied('TASK_MODEL_BUDGET_PROFILE_CHANGED',
      'Existing durable model budget cannot be silently increased, lowered, or reset.');
  }
  let tokenSum = 0, costSum = 0;
  const calls = new Set<string>(), reservations = new Set<string>();
  for (const item of file.reservations) {
    if (!validRecord(item) || calls.has(item.callId) || reservations.has(item.reservationId)) {
      denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT',
        'Stored model budget contains an invalid or duplicate reservation.');
    }
    calls.add(item.callId);
    reservations.add(item.reservationId);
    tokenSum += item.maxOutputTokens;
    costSum += item.maxCostMicros;
    if (!Number.isSafeInteger(tokenSum) || !Number.isSafeInteger(costSum) ||
        tokenSum > expected.maxOutputTokens || costSum > expected.maxCostMicros) {
      denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT', 'Persisted model reservations exceed the budget.');
    }
  }
  return file;
}

/**
 * Caller-owned local per-scope durable ledger. Reserve atomically before
 * model transmission; a crash, rejected result or timeout never refunds budget.
 *
 * This is not wired into the installed runtime and has no authority to grant
 * model scope or dispatch actions. Caller must put stateDir in a protected,
 * owner-controlled filesystem root and separately enforce task/account scope.
 */
export class DurableModelCallBudgetLedger implements ModelCallBudgetLedger {
  readonly #file: string;
  readonly #initializedMarker: string;
  readonly #limits: DurableModelBudgetLimits;

  constructor(stateDir: string, limits: DurableModelBudgetLimits) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || !validLimits(limits)) {
      denied('TASK_MODEL_BUDGET_CONFIG_INVALID',
        'An absolute owner-controlled durable state directory and bounded profile are required.');
    }
    this.#file = path.join(path.resolve(stateDir), 'model-budget', 'ledger-v1.json');
    this.#initializedMarker = path.join(path.dirname(this.#file), 'initialized-v1.json');
    this.#limits = { ...limits };
  }

  async #prepare(): Promise<void> {
    const dir = path.dirname(this.#file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT',
        'Model budget directory must be a real protected directory, not a symlink.');
    }
  }

  async #read(): Promise<BudgetFile> {
    let initialized = false;
    try {
      const stamp = JSON.parse(await readDurableStateText(this.#initializedMarker, OPTIONS));
      if (!exactKeys(stamp, ['schemaVersion', 'profileDigest']) || stamp.schemaVersion !== 1 ||
          stamp.profileDigest !== this.#profileDigest()) {
        denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT',
          'Model ledger initialization marker is invalid or its budget profile changed.');
      }
      initialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let raw: string;
    try { raw = await readDurableStateText(this.#file, OPTIONS); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (initialized) denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT',
          'Previously initialized model budget ledger disappeared; never reset the consumed budget.');
        return { schemaVersion: 1, limits: { ...this.#limits }, reservations: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT', 'Stored model budget JSON is invalid.'); }
    if (!initialized) denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT',
      'Existing model ledger lacks its durable initialization marker.');
    return validateFile(parsed, this.#limits);
  }

  #profileDigest(): string {
    return crypto.createHash('sha256').update(JSON.stringify(this.#limits)).digest('hex');
  }

  async reserve(input: {
    callId: string; modelId: string; maxOutputTokens: number; maxCostMicros: number;
  }): Promise<{ reservationId: string }> {
    if (!input || !UUID.test(input.callId) || typeof input.modelId !== 'string' ||
        !input.modelId.trim() || input.modelId.trim() !== input.modelId ||
        input.modelId.length > 128 || !allowedInt(input.maxOutputTokens, 64, 4096) ||
        !allowedInt(input.maxCostMicros, 0, 2_000_000)) {
      denied('TASK_MODEL_BUDGET_RESERVATION_INVALID', 'Model call reservation is invalid.');
    }
    await this.#prepare();
    return await withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      if (state.reservations.some(record => record.callId === input.callId)) {
        denied('TASK_MODEL_BUDGET_DUPLICATE', 'Reusing a model call identity cannot create a new reservation.');
      }
      const usedTokens = state.reservations.reduce((n, item) => n + item.maxOutputTokens, 0);
      const usedCost = state.reservations.reduce((n, item) => n + item.maxCostMicros, 0);
      if (state.reservations.length >= this.#limits.maxCalls ||
          usedTokens + input.maxOutputTokens > this.#limits.maxOutputTokens ||
          usedCost + input.maxCostMicros > this.#limits.maxCostMicros) {
        denied('TASK_MODEL_BUDGET_EXHAUSTED',
          'Durably reserved model calls, output tokens or spending would exceed the owner-set budget.');
      }
      const reservationId = crypto.randomUUID();
      state.reservations.push({
        reservationId, callId: input.callId, modelId: input.modelId,
        maxOutputTokens: input.maxOutputTokens, maxCostMicros: input.maxCostMicros,
        status: 'RESERVED'
      });
      // Once any budget is committed, deleting the ledger alone must not
      // silently mint a fresh budget. Marker is durable BEFORE the first ledger.
      if (state.reservations.length === 1) {
        try {
          await createDurableStateBytes(this.#initializedMarker, Buffer.from(JSON.stringify({
            schemaVersion: 1, profileDigest: this.#profileDigest()
          }), 'utf8'), OPTIONS);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // EEXIST is only acceptable when it is the exact marker we just
          // validated in #read(); otherwise an unknown writer wins.
          const marker = JSON.parse(await readDurableStateText(this.#initializedMarker, OPTIONS));
          if (!exactKeys(marker, ['schemaVersion', 'profileDigest']) ||
              marker.schemaVersion !== 1 || marker.profileDigest !== this.#profileDigest()) {
            denied('TASK_MODEL_BUDGET_LEDGER_CORRUPT', 'Conflicting budget initialization marker.');
          }
        }
      }
      // The model must not see the prompt until this write and fsync succeeded.
      await writeDurableStateText(this.#file, JSON.stringify(state), OPTIONS);
      return { reservationId };
    });
  }

  async finalize(input: {
    reservationId: string; callId: string; outcome: 'VALIDATED_PROPOSAL' | 'UNKNOWN_SPEND';
  }): Promise<void> {
    if (!input || !UUID.test(input.reservationId) || !UUID.test(input.callId) ||
        !['VALIDATED_PROPOSAL', 'UNKNOWN_SPEND'].includes(input.outcome)) {
      denied('TASK_MODEL_BUDGET_FINALIZATION_INVALID', 'Model finalization identity is invalid.');
    }
    await this.#prepare();
    return await withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const item = state.reservations.find(record => record.reservationId === input.reservationId &&
        record.callId === input.callId);
      if (!item) denied('TASK_MODEL_BUDGET_UNKNOWN_RESERVATION', 'No matching prior durable reservation.');
      if (item.status === input.outcome) return;
      if (item.status !== 'RESERVED') {
        denied('TASK_MODEL_BUDGET_SETTLEMENT_CONFLICT',
          'An already finalized model call cannot be reclassified or refunded.');
      }
      item.status = input.outcome;
      // Finalizing does not alter reserved counters or refund unknown spending.
      await writeDurableStateText(this.#file, JSON.stringify(state), OPTIONS);
    });
  }

  async inspect(): Promise<{
    calls: number; tokensReserved: number; costMicrosReserved: number;
    outstanding: number; unknownSpend: number; remainingCalls: number;
    remainingTokens: number; remainingCostMicros: number;
  }> {
    await this.#prepare();
    return await withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const calls = state.reservations.length;
      const tokensReserved = state.reservations.reduce((sum, r) => sum + r.maxOutputTokens, 0);
      const costMicrosReserved = state.reservations.reduce((sum, r) => sum + r.maxCostMicros, 0);
      return {
        calls, tokensReserved, costMicrosReserved,
        outstanding: state.reservations.filter(r => r.status === 'RESERVED').length,
        unknownSpend: state.reservations.filter(r => r.status === 'UNKNOWN_SPEND').length,
        remainingCalls: this.#limits.maxCalls - calls,
        remainingTokens: this.#limits.maxOutputTokens - tokensReserved,
        remainingCostMicros: this.#limits.maxCostMicros - costMicrosReserved
      };
    });
  }
}
