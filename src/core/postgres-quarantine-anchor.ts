import type { PostgresQueryHost } from './control-plane-store.ts';
import type { QuarantineLedgerAnchor, QuarantineLedgerPosition } from './organization-quarantine-adjudication.ts';
import { OperatorError } from './errors.ts';

const HEAD = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:@/+=-]{1,128}$/;
const GENESIS = '0'.repeat(64);

/**
 * Production integration seam for an independently operated PostgreSQL
 * quarantine high-water store. Supply an actual DIFFERENT database/backup
 * authority from the local quarantine journal and its restoration domain.
 * Sharing the primary control-plane database does not provide rollback proof.
 *
 * Database principals used by the app should be limited to SELECT and the
 * conditional advance operation, without DROP/TRUNCATE privileges.
 */
export class PostgresQuarantineLedgerAnchor implements QuarantineLedgerAnchor {
  readonly #db: PostgresQueryHost;
  readonly #anchorId: string;

  constructor(db: PostgresQueryHost, anchorId: string) {
    if (!db || typeof db.query !== 'function' || !ID.test(anchorId)) {
      throw invalid('An independent PostgreSQL connection and bounded anchor ID are required.');
    }
    this.#db = db;
    this.#anchorId = anchorId;
  }

  /** Provision on a dedicated PostgreSQL service, before operator review. */
  async initialize(): Promise<void> {
    await this.#db.query(`CREATE TABLE IF NOT EXISTS mecord_quarantine_high_water (
      anchor_id varchar(128) PRIMARY KEY,
      record_count bigint NOT NULL CHECK (record_count >= 0),
      head_mac varchar(64) NOT NULL CHECK (head_mac ~ '^[0-9a-f]{64}$')
    )`);
    await this.#db.query(
      `INSERT INTO mecord_quarantine_high_water (anchor_id, record_count, head_mac)
       VALUES ($1, 0, $2) ON CONFLICT (anchor_id) DO NOTHING`,
      [this.#anchorId, GENESIS]
    );
  }

  async read(): Promise<QuarantineLedgerPosition> {
    const result = await this.#db.query<{ record_count: string | number; head_mac: string }>(
      `SELECT record_count, head_mac FROM mecord_quarantine_high_water WHERE anchor_id=$1`,
      [this.#anchorId]
    );
    if (result.rows.length !== 1) throw invalid('Independent quarantine anchor is uninitialized or duplicated.');
    const count = Number(result.rows[0]!.record_count);
    const headMac = String(result.rows[0]!.head_mac);
    if (!Number.isSafeInteger(count) || count < 0 || !HEAD.test(headMac) ||
        (count === 0 && headMac !== GENESIS)) {
      throw invalid('Independent quarantine anchor contains invalid high-water evidence.');
    }
    return { count, headMac };
  }

  async compareAndAdvance(expected: QuarantineLedgerPosition, next: QuarantineLedgerPosition): Promise<void> {
    valid(expected);
    valid(next);
    if (expected.count >= Number.MAX_SAFE_INTEGER ||
        next.count !== expected.count + 1 || next.headMac === expected.headMac) {
      throw invalid('Quarantine high-water CAS cannot rewind, skip, or reuse an existing head.');
    }
    const updated = await this.#db.query(
      `UPDATE mecord_quarantine_high_water
          SET record_count=$1, head_mac=$2
        WHERE anchor_id=$3 AND record_count=$4 AND head_mac=$5`,
      [next.count, next.headMac, this.#anchorId, expected.count, expected.headMac]
    );
    // Never infer success from absence of SQL error. A competing operator or
    // restored/wrong remote database can make the conditional update a no-op.
    if (updated.rowCount !== 1) {
      throw new OperatorError('QUARANTINE_ANCHOR_CONFLICT',
        'Independent high-water authority rejected the exact expected ledger head.');
    }
  }
}

function valid(input: QuarantineLedgerPosition): void {
  if (!input || !Number.isSafeInteger(input.count) || input.count < 0 || !HEAD.test(String(input.headMac))) {
    throw invalid('Malformed independently anchored quarantine position.');
  }
  if (input.count === 0 && input.headMac !== GENESIS) {
    throw invalid('Quarantine genesis must use the canonical zero MAC.');
  }
}
function invalid(message: string): OperatorError {
  return new OperatorError('QUARANTINE_ANCHOR_INVALID', message, { retryable: false });
}
