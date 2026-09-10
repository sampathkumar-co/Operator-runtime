import path from 'node:path';
import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import { appendDurableStateText, readDurableStateText, writeDurableStateText } from './durable-state.ts';

const SECRET_KEY = /(token|password|secret|authorization|cookie|private.?key|api.?key)/i;
const AUDIT_CHAIN_VERSION = 1 as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_AUDIT_BYTES = 256 * 1024 * 1024;
const MAX_AUDIT_HEAD_BYTES = 64 * 1024;
const MAX_AUDIT_EVENT_BYTES = 256 * 1024;
const MAX_REDACT_COLLECTION_ITEMS = 1000;
const MAX_TAIL_EVENTS = 1000;
const AUDIT_STATE_OPTIONS = {
  maxBytes: MAX_AUDIT_BYTES,
  errorCode: 'AUDIT_INTEGRITY_FAILED',
  invalidMessage: 'Audit log file is invalid.'
} as const;
const AUDIT_HEAD_OPTIONS = {
  maxBytes: MAX_AUDIT_HEAD_BYTES,
  errorCode: 'AUDIT_INTEGRITY_FAILED',
  invalidMessage: 'Audit head file is invalid.'
} as const;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_REDACT_COLLECTION_ITEMS).map((item) => redact(item, depth + 1));
    if (value.length > MAX_REDACT_COLLECTION_ITEMS) output.push(`[TRUNCATED_${value.length - MAX_REDACT_COLLECTION_ITEMS}_ITEMS]`);
    return output;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, MAX_REDACT_COLLECTION_ITEMS)) {
      output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(child, depth + 1);
    }
    if (entries.length > MAX_REDACT_COLLECTION_ITEMS) output.__operatorTruncatedEntries = entries.length - MAX_REDACT_COLLECTION_ITEMS;
    return output;
  }
  if (typeof value === 'string' && value.length > 16_384) return `${value.slice(0, 16_384)}…[TRUNCATED]`;
  return value;
}

export interface AuditEvent {
  id?: string;
  timestamp?: string;
  taskId?: string;
  sessionId?: string;
  deviceId?: string;
  capability: string;
  target?: string;
  result: 'allowed' | 'blocked' | 'success' | 'failure';
  risk: string;
  evidenceRefs?: string[];
  rollbackState?: string;
  details?: Record<string, unknown>;
  chainVersion?: 1;
  previousHash?: string | null;
  hash?: string;
}

interface AuditHead {
  version: 1;
  count: number;
  headHash: string | null;
  updatedAt: string;
}

interface VerifiedAudit {
  events: AuditEvent[];
  count: number;
  headHash: string | null;
}

export interface AuditIntegrityStatus {
  valid: true;
  count: number;
  headHash: string | null;
}

export class AuditLog {
  #file: string;
  #headFile: string;
  #head: { count: number; headHash: string | null } | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'audit.ndjson');
    this.#headFile = path.join(root, 'audit-head.json');
  }

  async append(event: AuditEvent): Promise<AuditEvent> {
    let appended!: AuditEvent;
    const operation = this.#queue.then(async () => {
      const head = await this.#loadHead();
      const base = stripChain(redact({
        ...event,
        id: event.id ?? crypto.randomUUID(),
        timestamp: event.timestamp ?? new Date().toISOString()
      }) as AuditEvent);
      appended = chainEvent(base, head.headHash);
      const line = `${JSON.stringify(appended)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_EVENT_BYTES) {
        throw new OperatorError('AUDIT_EVENT_TOO_LARGE', `Audit event exceeds ${MAX_AUDIT_EVENT_BYTES} UTF-8 bytes after redaction.`);
      }
      await appendDurableStateText(this.#file, line, AUDIT_STATE_OPTIONS);
      const next = { count: head.count + 1, headHash: appended.hash! };
      try {
        await this.#writeHead(next);
        this.#head = next;
      } catch (error) {
        this.#head = null;
        throw error;
      }
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
    return appended;
  }

  async tail(limit = 100): Promise<AuditEvent[]> {
    await this.#queue;
    const verified = await this.#readAndVerify(true);
    const parsed = Number(limit);
    const bounded = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_TAIL_EVENTS) : 100;
    return verified.events.slice(-bounded);
  }

  async verifyIntegrity(): Promise<AuditIntegrityStatus> {
    await this.#queue;
    const verified = await this.#readAndVerify(true);
    return { valid: true, count: verified.count, headHash: verified.headHash };
  }

  async #loadHead(): Promise<{ count: number; headHash: string | null }> {
    if (this.#head) return this.#head;
    const verified = await this.#readAndVerify(true);
    this.#head = { count: verified.count, headHash: verified.headHash };
    return this.#head;
  }

  async #readAndVerify(reconcileAnchor: boolean): Promise<VerifiedAudit> {
    let text: string;
    try {
      text = await readDurableStateText(this.#file, AUDIT_STATE_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty: VerifiedAudit = { events: [], count: 0, headHash: null };
        if (reconcileAnchor) await this.#reconcileAnchor(empty);
        return empty;
      }
      throw error;
    }

    const lines = text.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      const empty: VerifiedAudit = { events: [], count: 0, headHash: null };
      if (reconcileAnchor) await this.#reconcileAnchor(empty);
      return empty;
    }

    let parsed: AuditEvent[];
    try {
      parsed = lines.map((line) => JSON.parse(line) as AuditEvent);
    } catch {
      throw integrityError('Audit log contains invalid or partial JSON.');
    }

    const chained = parsed.filter((event) => event.chainVersion === AUDIT_CHAIN_VERSION || event.hash !== undefined || event.previousHash !== undefined);
    if (chained.length === 0) {
      parsed = await this.#migrateLegacy(parsed);
    } else if (chained.length !== parsed.length) {
      throw integrityError('Audit log mixes chained and unchained records.');
    }

    let previousHash: string | null = null;
    for (let index = 0; index < parsed.length; index += 1) {
      const event = parsed[index]!;
      if (event.chainVersion !== AUDIT_CHAIN_VERSION || typeof event.hash !== 'string' || !HASH_RE.test(event.hash)) {
        throw integrityError(`Audit record ${index} has invalid chain metadata.`);
      }
      if (event.previousHash !== previousHash) {
        throw integrityError(`Audit record ${index} does not link to the preceding record.`);
      }
      const expected = eventHash(stripChain(event), previousHash);
      if (!safeHashEqual(event.hash, expected)) {
        throw integrityError(`Audit record ${index} hash verification failed.`);
      }
      previousHash = event.hash;
    }

    const verified = { events: parsed, count: parsed.length, headHash: previousHash };
    if (reconcileAnchor) await this.#reconcileAnchor(verified);
    return verified;
  }

  async #migrateLegacy(events: AuditEvent[]): Promise<AuditEvent[]> {
    let previousHash: string | null = null;
    const migrated = events.map((event) => {
      const chained = chainEvent(stripChain(event), previousHash);
      previousHash = chained.hash!;
      return chained;
    });
    await writeDurableStateText(this.#file, `${migrated.map((event) => JSON.stringify(event)).join('\n')}\n`, AUDIT_STATE_OPTIONS);
    await this.#writeHead({ count: migrated.length, headHash: previousHash });
    return migrated;
  }

  async #reconcileAnchor(verified: VerifiedAudit): Promise<void> {
    let anchor: AuditHead | null = null;
    try {
      anchor = JSON.parse(await readDurableStateText(this.#headFile, AUDIT_HEAD_OPTIONS)) as AuditHead;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw integrityError('Audit head metadata is unreadable.');
    }

    if (!anchor) {
      if (verified.count > 0) await this.#writeHead({ count: verified.count, headHash: verified.headHash });
      return;
    }
    if (anchor.version !== 1 || !Number.isSafeInteger(anchor.count) || anchor.count < 0 ||
        (anchor.headHash !== null && (typeof anchor.headHash !== 'string' || !HASH_RE.test(anchor.headHash)))) {
      throw integrityError('Audit head metadata is invalid.');
    }
    if (anchor.count === verified.count && anchor.headHash === verified.headHash) return;

    // Recover only the narrow crash window where one fully chained line reached disk
    // but its head-file update did not. Anything else fails closed.
    if (verified.count === anchor.count + 1) {
      const last = verified.events.at(-1)!;
      if (last.previousHash === anchor.headHash) {
        await this.#writeHead({ count: verified.count, headHash: verified.headHash });
        return;
      }
    }
    throw integrityError('Audit log and persisted head metadata disagree.');
  }

  async #writeHead(head: { count: number; headHash: string | null }): Promise<void> {
    const record: AuditHead = {
      version: 1,
      count: head.count,
      headHash: head.headHash,
      updatedAt: new Date().toISOString()
    };
    await writeDurableStateText(this.#headFile, `${JSON.stringify(record, null, 2)}\n`, AUDIT_HEAD_OPTIONS);
  }
}

function stripChain(event: AuditEvent): AuditEvent {
  const { chainVersion: _chainVersion, previousHash: _previousHash, hash: _hash, ...base } = event;
  return base;
}

function chainEvent(base: AuditEvent, previousHash: string | null): AuditEvent {
  return {
    ...base,
    chainVersion: AUDIT_CHAIN_VERSION,
    previousHash,
    hash: eventHash(base, previousHash)
  };
}

function eventHash(base: AuditEvent, previousHash: string | null): string {
  return crypto.createHash('sha256')
    .update('operator-audit-chain-v1\n')
    .update(previousHash ?? 'GENESIS')
    .update('\n')
    .update(canonicalJson(base))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return 'null';
}

function safeHashEqual(actual: string, expected: string): boolean {
  if (!HASH_RE.test(actual) || !HASH_RE.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function integrityError(message: string): OperatorError {
  return new OperatorError('AUDIT_INTEGRITY_FAILED', message);
}
