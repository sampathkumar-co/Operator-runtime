import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ControlPlaneSnapshot, ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';

/**
 * An independent, monotonic restore anchor must live OUTSIDE the target
 * control-plane backup/restore domain. Merely reloading a signed approval from
 * the same restored files cannot defend against whole-store rollback.
 */
export interface ControlPlaneRestoreManifest {
  schemaVersion: 1;
  anchorId: string;
  epoch: number;
  snapshotDigest: string;
  issuedAt: string;
  expiresAt: string;
}
export interface SignedControlPlaneRestoreManifest {
  manifest: ControlPlaneRestoreManifest;
  signature: string;
}
export interface ControlPlaneRestoreAnchor {
  /**
   * Pin and exclusively serialize the CURRENT externally persisted latest
   * approval for the whole callback, including the control-plane restore.
   * On failure to establish durable ownership, reject instead of invoking
   * the callback. The callback must run at most once: restore is not replayable.
   */
  withLatestExclusive<T>(
    work: (latest: SignedControlPlaneRestoreManifest) => Promise<T>
  ): Promise<T>;
}
export interface ControlPlaneRestoreGuard {
  anchor: ControlPlaneRestoreAnchor;
  anchorId: string;
  publicKeyPem: string;
  /** Trusted operator authorization; called inside the anchor's exclusive boundary. */
  authorizeRestore: (manifest: ControlPlaneRestoreManifest) => Promise<void>;
  clock?: () => Date;
}

const DIGEST = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ANCHOR = /^[A-Za-z0-9._:@/+=-]{1,128}$/;
const MAX_WITNESS_AGE_MS = 15 * 60_000;

/**
 * Restore ONLY a snapshot named by the latest signed external authority.
 * Snapshot digest covers live rows and invisible generation tombstones.
 * A signed historical manifest is insufficient unless it is the exclusive
 * latest manifest returned by the trusted external anchor.
 *
 * There is no automatic migration of legacy backups: a missing or outdated
 * witness fails closed rather than creating generation-1 replay authority.
 * This helper protects explicit witnessed restore callers; direct .restore()
 * remains a separate lower-level API and must not be exposed to operators in
 * deployment configurations requiring external rollback protection.
 */
export async function restoreControlPlaneWithSignedWitness(
  store: Pick<ControlPlaneStore, 'restore'>,
  snapshot: ControlPlaneSnapshot,
  guard: ControlPlaneRestoreGuard
): Promise<void> {
  if (!guard || typeof guard.authorizeRestore !== 'function' ||
      !guard.anchor || typeof guard.anchor.withLatestExclusive !== 'function' ||
      typeof guard.publicKeyPem !== 'string' || !ANCHOR.test(guard.anchorId)) {
    throw invalid('Restore requires a trusted remote anchor, pinned verifier and operator authorization.');
  }
  if (!snapshot || typeof snapshot !== 'object' || !DIGEST.test(snapshot.digest)) {
    throw invalid('Restored snapshot must carry a complete digest.');
  }
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(guard.publicKeyPem); }
  catch { throw invalid('Pinned restore witness public key is invalid.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw invalid('Restore witness must use a pinned Ed25519 signing key.');

  const now = (guard.clock ?? (() => new Date()))().getTime();
  if (!Number.isFinite(now)) throw invalid('Restore authorization clock is unavailable.');
  await guard.anchor.withLatestExclusive(async (signed) => {
    if (!signed || typeof signed !== 'object') throw invalid('External restore witness was unavailable.');
    const manifest = validateManifest(signed.manifest, now);
    if (manifest.anchorId !== guard.anchorId || manifest.snapshotDigest !== snapshot.digest) {
      throw new OperatorError('CONTROL_PLANE_RESTORE_WITNESS_STALE',
        'The external high-water witness does not authorize this exact snapshot. Reconciliation is required.');
    }
    if (typeof signed.signature !== 'string' || !SIGNATURE.test(signed.signature) ||
        !crypto.verify(null, Buffer.from(canonicalJson(manifest), 'utf8'),
          key, Buffer.from(signed.signature, 'base64url'))) {
      throw invalid('Independent restore witness signature is invalid.');
    }
    await guard.authorizeRestore(manifest);
    // The external authority MUST hold its durable exclusive epoch during
    // this call. A new witness cannot supersede it mid-restore.
    await store.restore(snapshot);
  });
}

function validateManifest(input: ControlPlaneRestoreManifest, now: number): ControlPlaneRestoreManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 ||
      typeof input.anchorId !== 'string' || !ANCHOR.test(input.anchorId) ||
      !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
      typeof input.snapshotDigest !== 'string' || !DIGEST.test(input.snapshotDigest)) {
    throw invalid('Restore manifest is malformed.');
  }
  const issuedAt = canonicalIso(input.issuedAt), expiresAt = canonicalIso(input.expiresAt);
  const issued = Date.parse(issuedAt), expires = Date.parse(expiresAt);
  if (issued > now || now >= expires || expires - issued > MAX_WITNESS_AGE_MS) {
    throw new OperatorError('CONTROL_PLANE_RESTORE_WITNESS_EXPIRED',
      'Restore requires a freshly signed witness from the current external epoch.');
  }
  return { schemaVersion: 1, anchorId: input.anchorId, epoch: input.epoch,
    snapshotDigest: input.snapshotDigest, issuedAt, expiresAt };
}
function canonicalIso(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) ||
      new Date(input).toISOString() !== input) throw invalid('Restore witness time is invalid.');
  return input;
}
function invalid(message: string): OperatorError {
  return new OperatorError('CONTROL_PLANE_RESTORE_WITNESS_INVALID', message);
}
