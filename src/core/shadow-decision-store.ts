import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { appendDurableStateText, readDurableStateText } from './durable-state.ts';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { RuntimeAdvisoryCommand } from './intelligence-adapters.ts';

export type ShadowSource = 'ADAPTIVE_INTELLIGENCE' | 'VERIFIED_PLAN';

export interface ShadowDecisionEvent {
  schemaVersion: 1;
  id: string;
  source: ShadowSource;
  executionContextDigest: string;
  stateDigest: string;
  recommendation: RuntimeAdvisoryCommand;
  reasonCode: string;
  targetNodeId?: string;
  cohortId?: string;
  at: string;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const STORE_OPTIONS = {
  maxBytes: MAX_FILE_BYTES,
  errorCode: 'SHADOW_DECISION_CORRUPT',
  invalidMessage: 'Shadow decision state is invalid.'
} as const;

export class ShadowDecisionStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'shadow-decisions.ndjson');
  }

  async append(input: Omit<ShadowDecisionEvent, 'schemaVersion' | 'id'>): Promise<ShadowDecisionEvent> {
    const event = normalizeShadowDecision({
      schemaVersion: 1,
      ...input,
      id: crypto.createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex')
    });
    const line = JSON.stringify(event) + '\n';
    if (Buffer.byteLength(line, 'utf8') > 16 * 1024) throw invalid('Shadow event exceeds bounded size.');
    const run = this.#serial.then(() => withDurableStateLock(this.#file, () => appendDurableStateText(this.#file, line, STORE_OPTIONS)));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return event;
  }

  async list(input: { cohortId?: string; limit?: number } = {}): Promise<ShadowDecisionEvent[]> {
    await this.#serial;
    const text = await withDurableStateLock(this.#file, async () => {
      try {
        return await readDurableStateText(this.#file, STORE_OPTIONS);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    });
    const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit! : 1000, 1), 10_000);
    const cohortId = input.cohortId === undefined ? undefined : boundedId(input.cohortId, 'cohortId');
    return text.split(/\r?\n/).filter(Boolean)
      .map((line) => normalizeShadowDecision(JSON.parse(line)))
      .filter((event) => !cohortId || event.cohortId === cohortId)
      .slice(-limit);
  }
}

export function normalizeShadowDecision(input: unknown): ShadowDecisionEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Shadow decision must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw invalid('Shadow decision schemaVersion must be 1.');
  const source = raw.source;
  if (source !== 'ADAPTIVE_INTELLIGENCE' && source !== 'VERIFIED_PLAN') throw invalid('Shadow source is invalid.');
  const recommendation = raw.recommendation;
  if (!['OBSERVE','REGROUND','REPLAN','REPAIR','RECONCILE','WAIT','VERIFY','FAIL_SAFE','ESCALATE'].includes(String(recommendation))) {
    throw invalid('Shadow recommendation is invalid.');
  }
  return {
    schemaVersion: 1,
    id: digest(raw.id, 'id'),
    source,
    executionContextDigest: digest(raw.executionContextDigest, 'executionContextDigest'),
    stateDigest: digest(raw.stateDigest, 'stateDigest'),
    recommendation: recommendation as RuntimeAdvisoryCommand,
    reasonCode: boundedId(raw.reasonCode, 'reasonCode'),
    ...(raw.targetNodeId !== undefined ? { targetNodeId: boundedId(raw.targetNodeId, 'targetNodeId') } : {}),
    ...(raw.cohortId !== undefined ? { cohortId: boundedId(raw.cohortId, 'cohortId') } : {}),
    at: canonicalIso(raw.at)
  };
}
function digest(v: unknown, l: string): string {
  const s = String(v ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw invalid(`${l} is invalid.`);
  return s;
}
function boundedId(v: unknown, l: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(v)) throw invalid(`${l} is invalid.`);
  return v;
}
function canonicalIso(v: unknown): string {
  const s = String(v ?? '');
  if (!s || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) throw invalid('Shadow timestamp must be canonical ISO.');
  return s;
}
function invalid(message: string): OperatorError {
  return new OperatorError('SHADOW_DECISION_INVALID', message);
}
