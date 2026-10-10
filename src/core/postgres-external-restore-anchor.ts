import type { PostgresQueryHost, PostgresQueryClient } from './control-plane-store.ts';
import type {
  ControlPlaneRestoreAnchor, SignedControlPlaneRestoreManifest,
  ControlPlaneRestoreManifest
} from './control-plane-restore-witness.ts';
import { OperatorError } from './errors.ts';

/**
 * Read-only adapter for a PostgreSQL restore witness in a SEPARATE backup and
 * administrator trust domain from the target control-plane database.
 *
 * Operators must provision the witness table and a separate monotonic signed
 * manifest publisher (UPDATE must advance epochs; DELETE/TRUNCATE disallowed).
 * This runtime must receive only SELECT permissions on the witness table.
 * A witness database restored alongside the target is NOT independent.
 *
 * The callback runs while a PostgreSQL row lock is held. Other publishers
 * updating the same anchor_id must use normal PostgreSQL UPDATE/row locking;
 * they cannot advance the current signed manifest during a target restore.
 */
export class PostgresExternalRestoreAnchor implements ControlPlaneRestoreAnchor {
  #db: PostgresQueryHost;
  #anchorId: string;

  constructor(db: PostgresQueryHost, anchorId: string) {
    if (!db || typeof db.connect !== 'function') {
      throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_POOL_REQUIRED',
        'An independent pooled PostgreSQL witness with pinned transaction connections is required.');
    }
    if (typeof anchorId !== 'string' || !/^[A-Za-z0-9._:@/+=-]{1,128}$/.test(anchorId)) {
      throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_INVALID',
        'External restore witness identity is invalid.');
    }
    this.#db = db;
    this.#anchorId = anchorId;
  }

  async withLatestExclusive<T>(
    work: (latest: SignedControlPlaneRestoreManifest) => Promise<T>
  ): Promise<T> {
    if (typeof work !== 'function') {
      throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_INVALID',
        'External restore witness callback is invalid.');
    }
    let connection: PostgresQueryClient;
    try {
      connection = await this.#db.connect!();
    } catch {
      throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_UNAVAILABLE',
        'Independent restore witness connection could not be established.');
    }
    if (!connection || typeof connection.query !== 'function' || typeof connection.release !== 'function') {
      throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_UNAVAILABLE',
        'Independent restore witness did not return a releasable pinned PostgreSQL connection.');
    }
    let began = false;
    let unsafe = false;
    try {
      await connection.query('BEGIN');
      began = true;
      const result = await connection.query<{
        anchor_id: unknown;
        signed_manifest: unknown;
        signature: unknown;
      }>('SELECT anchor_id, signed_manifest, signature FROM mecord_restore_witness_anchor WHERE anchor_id=$1 FOR UPDATE',
        [this.#anchorId]);
      if (result.rows.length !== 1) {
        throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_UNAVAILABLE',
          'No uniquely pinned latest external restore witness exists.');
      }
      const row = result.rows[0]!;
      const manifest = row.signed_manifest;
      if (row.anchor_id !== this.#anchorId ||
          !manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
          (manifest as Record<string, unknown>).anchorId !== this.#anchorId ||
          typeof row.signature !== 'string' || row.signature.length > 512 ||
          JSON.stringify(manifest).length > 4096) {
        throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_INVALID',
          'External restore witness row is malformed or misbound.');
      }
      // The signed-witness guard validates the entire canonical manifest,
      // Ed25519 signature, freshness, operator authorization, and snapshot
      // digest before invoking the actual target restore.
      const latest: SignedControlPlaneRestoreManifest = {
        manifest: structuredClone(manifest) as ControlPlaneRestoreManifest,
        signature: row.signature
      };
      const resultValue = await work(latest);
      await connection.query('COMMIT');
      began = false;
      return resultValue;
    } catch (error) {
      if (began) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          unsafe = true;
          throw new OperatorError('CONTROL_PLANE_RESTORE_ANCHOR_UNSAFE',
            'External restore witness transaction rollback failed; its session cannot be reused.');
        }
      }
      throw error;
    } finally {
      connection.release(unsafe ? new Error('Uncertain external restore witness connection') : undefined);
    }
  }
}
