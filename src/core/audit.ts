import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
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
  traceId?: string;
  operationId?: string;
  taskId?: string;
  missionId?: string;
  workItemId?: string;
  workerId?: string;
  sessionId?: string;
  deviceId?: string;
  actionId?: string;
  providerId?: string;
  procedureId?: string;
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


export interface AuditQuery {
  traceId?: string;
  operationId?: string;
  taskId?: string;
  missionId?: string;
  workItemId?: string;
  workerId?: string;
  deviceId?: string;
  actionId?: string;
  providerId?: string;
  procedureId?: string;
  capability?: string;
  result?: AuditEvent['result'];
  limit?: number;
}

export interface AuditSummary {
  total: number;
  success: number;
  failure: number;
  blocked: number;
  allowed: number;
  byCapability: Record<string, number>;
  byProvider: Record<string, number>;
  averageDurationMs?: number;
}

export class AuditLog {
  #file: string;
  #headFile: string;
  #segmentDir: string;
  #maxSegmentBytes: number;
  #head: { count: number; headHash: string | null } | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { maxSegmentBytes?: number } = {}) {
    const root = path.resolve(stateDir);
    this.#file = path.join(root, 'audit.ndjson');
    this.#headFile = path.join(root, 'audit-head.json');
    this.#segmentDir = path.join(root, 'audit-segments');
    this.#maxSegmentBytes = Math.min(Math.max(options.maxSegmentBytes ?? 240 * 1024 * 1024, MAX_AUDIT_EVENT_BYTES), MAX_AUDIT_BYTES);
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
      await this.#rotateIfNeeded(head, Buffer.byteLength(line, 'utf8'));
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


  async query(input: AuditQuery = {}): Promise<AuditEvent[]> {
    await this.#queue;
    const verified = await this.#readAndVerify(true);
    const parsed = Number(input.limit ?? 100);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_TAIL_EVENTS) : 100;
    const keys = [
      'traceId', 'operationId', 'taskId', 'missionId', 'workItemId', 'workerId',
      'deviceId', 'actionId', 'providerId', 'procedureId', 'capability', 'result'
    ] as const;
    const filtered = verified.events.filter((event) => keys.every((key) => {
      const expected = input[key];
      return expected === undefined || event[key] === expected;
    }));
    return filtered.slice(-limit);
  }

  async summary(input: Omit<AuditQuery, 'limit'> = {}): Promise<AuditSummary> {
    const events = await this.query({ ...input, limit: MAX_TAIL_EVENTS });
    const byCapability: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    let durationTotal = 0;
    let durationCount = 0;
    let success = 0;
    let failure = 0;
    let blocked = 0;
    let allowed = 0;
    for (const event of events) {
      byCapability[event.capability] = (byCapability[event.capability] ?? 0) + 1;
      if (event.providerId) byProvider[event.providerId] = (byProvider[event.providerId] ?? 0) + 1;
      if (event.result === 'success') success += 1;
      else if (event.result === 'failure') failure += 1;
      else if (event.result === 'blocked') blocked += 1;
      else allowed += 1;
      const duration = Number(event.details?.durationMs);
      if (Number.isFinite(duration) && duration >= 0) {
        durationTotal += duration;
        durationCount += 1;
      }
    }
    return {
      total: events.length,
      success,
      failure,
      blocked,
      allowed,
      byCapability,
      byProvider,
      ...(durationCount > 0 ? { averageDurationMs: durationTotal / durationCount } : {})
    };
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
    let activeText = '';
    try {
      activeText = await readDurableStateText(this.#file, AUDIT_STATE_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const archived = await this.#readSegments();
    const text = `${archived}${activeText}`;
    if (!text) {
      const empty: VerifiedAudit = { events: [], count: 0, headHash: null };
      if (reconcileAnchor) await this.#reconcileAnchor(empty);
      return empty;
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

  async #rotateIfNeeded(head: { count: number; headHash: string | null }, incomingBytes: number): Promise<void> {
    let size = 0;
    try { size = (await fs.lstat(this.#file)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (size === 0 || size + incomingBytes <= this.#maxSegmentBytes) return;
    if (!head.headHash || head.count < 1) throw integrityError('Audit segment rotation requires a valid non-empty chain head.');
    await fs.mkdir(this.#segmentDir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(this.#segmentDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw integrityError('Audit segment directory must be a real directory.');
    const name = `${String(head.count).padStart(16, '0')}-${head.headHash}.ndjson`;
    const destination = path.join(this.#segmentDir, name);
    try { await fs.lstat(destination); throw integrityError('Audit segment destination already exists.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.rename(this.#file, destination);
  }

  async #readSegments(): Promise<string> {
    let names: string[];
    try {
      const stat = await fs.lstat(this.#segmentDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw integrityError('Audit segment directory must be a real directory.');
      names = (await fs.readdir(this.#segmentDir)).filter((name) => name.endsWith('.ndjson')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
    let combined = '';
    let priorCount = 0;
    for (const name of names) {
      const match = /^(\d{16})-([0-9a-f]{64})\.ndjson$/.exec(name);
      if (!match) throw integrityError('Audit segment filename is invalid.');
      const count = Number(match[1]);
      if (!Number.isSafeInteger(count) || count <= priorCount) throw integrityError('Audit segment ordering metadata is invalid.');
      priorCount = count;
      combined += await readDurableStateText(path.join(this.#segmentDir, name), AUDIT_STATE_OPTIONS);
    }
    return combined;
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
