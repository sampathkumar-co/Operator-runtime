import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

export type IntentDirective = 'continue' | 'refine' | 'extend' | 'pause' | 'cancel' | 'redirect' | 'authorize' | 'revoke';

export interface IntentEnvelope {
  version: 1;
  conversationId: string;
  intentVersion: number;
  objective: string;
  authorizedScope: string[];
  prohibitedScope: string[];
  directive: IntentDirective;
  sourceTurnId: string;
  previousIntentDigest?: string;
  digest: string;
  createdAt: string;
}

const OPTIONS = {
  maxBytes: 1024 * 1024,
  errorCode: 'INTENT_STATE_CORRUPT',
  invalidMessage: 'Intent state is invalid.'
} as const;

export class IntentKernel {
  #file: string;
  #conversationId: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, conversationId: string) {
    const id = boundedId(conversationId, 'conversationId');
    this.#conversationId = id;
    this.#file = path.join(path.resolve(stateDir), 'intent', `${id}.json`);
  }

  async current(): Promise<IntentEnvelope | undefined> {
    try {
      const stored = validateEnvelope(JSON.parse(await readDurableStateText(this.#file, OPTIONS)));
      if (stored.conversationId !== this.#conversationId) {
        throw new OperatorError('INTENT_STATE_CORRUPT', 'Intent state belongs to a different conversation.');
      }
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async update(input: {
    objective: string;
    authorizedScope?: string[];
    prohibitedScope?: string[];
    directive: IntentDirective;
    sourceTurnId: string;
  }): Promise<IntentEnvelope> {
    let result!: IntentEnvelope;
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const previous = await this.current();
      if (previous && previous.intentVersion >= Number.MAX_SAFE_INTEGER) {
        throw new OperatorError('INTENT_VERSION_EXHAUSTED', 'Intent version capacity is exhausted; refusing unsafe version rollover.');
      }
      const createdAt = new Date().toISOString();
      const base = {
        version: 1 as const,
        conversationId: this.#conversationId,
        intentVersion: (previous?.intentVersion ?? 0) + 1,
        objective: boundedText(input.objective, 256 * 1024, 'objective'),
        authorizedScope: uniqueText(input.authorizedScope ?? [], 1000, 4096, 'authorizedScope'),
        prohibitedScope: uniqueText(input.prohibitedScope ?? [], 1000, 4096, 'prohibitedScope'),
        directive: validDirective(input.directive),
        sourceTurnId: boundedId(input.sourceTurnId, 'sourceTurnId'),
        ...(previous ? { previousIntentDigest: previous.digest } : {}),
        createdAt
      };
      result = { ...base, digest: digestOf(base) };
      await writeDurableStateText(this.#file, JSON.stringify(result, null, 2), OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  async assertCurrent(intentVersion: number, digest: string): Promise<IntentEnvelope> {
    const current = await this.current();
    if (!current) throw new OperatorError('INTENT_NOT_FOUND', 'No current intent exists.');
    if (current.intentVersion !== intentVersion || current.digest !== digest) {
      throw new OperatorError('INTENT_STALE', 'Execution intent is stale and must be revalidated.', {
        retryable: true,
        details: { currentIntentVersion: current.intentVersion }
      });
    }
    return current;
  }
}

function validateEnvelope(raw: any): IntentEnvelope {
  if (!raw || raw.version !== 1) throw new OperatorError('INTENT_STATE_CORRUPT', 'Intent version is invalid.');
  const base = {
    version: 1 as const,
    conversationId: boundedId(raw.conversationId, 'conversationId'),
    intentVersion: integer(raw.intentVersion, 1, Number.MAX_SAFE_INTEGER, 'intentVersion'),
    objective: boundedText(raw.objective, 256 * 1024, 'objective'),
    authorizedScope: uniqueText(raw.authorizedScope, 1000, 4096, 'authorizedScope'),
    prohibitedScope: uniqueText(raw.prohibitedScope, 1000, 4096, 'prohibitedScope'),
    directive: validDirective(raw.directive),
    sourceTurnId: boundedId(raw.sourceTurnId, 'sourceTurnId'),
    ...(raw.previousIntentDigest === undefined ? {} : { previousIntentDigest: digest(raw.previousIntentDigest) }),
    createdAt: iso(raw.createdAt)
  };
  const actual = digest(raw.digest);
  const expected = digestOf(base);
  if (actual !== expected) throw new OperatorError('INTENT_STATE_CORRUPT', 'Intent digest does not match.');
  return { ...base, digest: actual };
}

function digestOf(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validDirective(input: unknown): IntentDirective {
  const value = String(input ?? '') as IntentDirective;
  if (!['continue','refine','extend','pause','cancel','redirect','authorize','revoke'].includes(value)) {
    throw new OperatorError('INTENT_INPUT_INVALID', 'Intent directive is invalid.');
  }
  return value;
}
function boundedId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new OperatorError('INTENT_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw new OperatorError('INTENT_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
function uniqueText(input: unknown, maxItems: number, maxBytes: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('INTENT_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => boundedText(value, maxBytes, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('INTENT_INPUT_INVALID', `${label} contains duplicates.`);
  return values;
}
function digest(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('INTENT_STATE_CORRUPT', 'Intent digest is invalid.');
  return value;
}
function iso(input: unknown): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('INTENT_STATE_CORRUPT', 'Intent timestamp is invalid.');
  return value;
}
function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('INTENT_STATE_CORRUPT', `${label} is invalid.`);
  return value;
}
