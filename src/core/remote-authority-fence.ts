import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { ControlPlaneMutation, ControlPlaneRecord, ControlPlaneStore } from './control-plane-store.ts';
import { currentProcessInstance, sameProcessInstance, validProcessInstance, type ProcessInstanceIdentity } from './process-instance.ts';

/**
 * Shared-control-plane authority leases. All participating relay/provider hosts
 * MUST share one atomic ControlPlaneStore (PostgreSQL in a multi-host deployment).
 *
 * These tokens are *not* authorization by themselves: callers must install an
 * authenticated authorize() hook and providers must assertCurrent() at every
 * irreversible effect/commit boundary. A prior check cannot make an unrelated
 * external side effect atomic; uncertain effects still require quarantine.
 */
export interface RemoteAuthoritySubject {
  accountId: string;
  deviceId: string;
  authorityGeneration: number;
}
export interface RemoteAuthorityLease extends RemoteAuthoritySubject {
  schemaVersion: 1;
  ownerId: string;
  process: ProcessInstanceIdentity;
  leaseId: string;
  fenceToken: string;
  generation: number;
  expiresAt: string;
}
export interface RemoteAuthorityBarrier extends RemoteAuthoritySubject {
  schemaVersion: 1;
  revokedGeneration: number;
  generation: number;
}
export type RemoteAuthorityAuthorization = (subject: RemoteAuthoritySubject, mode: 'acquire' | 'revoke') => Promise<void>;
/** Provider policy must bind each mutation's namespace/key to the authorized account/device. */
export type RemoteAuthorityMutationAuthorization = (subject: RemoteAuthoritySubject, mutation: ControlPlaneMutation) => Promise<void>;

const NS = '__mecord_remote_authority';
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 300_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER = /^[A-Za-z0-9._:@/+=-]{1,256}$/;

export class RemoteAuthorityFenceStore {
  #store: ControlPlaneStore;
  #authorize: RemoteAuthorityAuthorization;
  #authorizeMutation?: RemoteAuthorityMutationAuthorization;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { authorize: RemoteAuthorityAuthorization; authorizeMutation?: RemoteAuthorityMutationAuthorization; clock?: () => Date }) {
    if (!options || typeof options.authorize !== 'function') {
      throw new OperatorError('REMOTE_AUTHORITY_POLICY_REQUIRED', 'A trusted external authorization hook is required.');
    }
    this.#store = store;
    this.#authorize = options.authorize;
    this.#authorizeMutation = options.authorizeMutation;
    this.#clock = options.clock ?? (() => new Date());
  }

  async acquire(subjectInput: RemoteAuthoritySubject, ownerInput: string, ttlMs = 30_000): Promise<RemoteAuthorityLease> {
    const subject = validateSubject(subjectInput);
    const ownerId = owner(ownerInput);
    const ms = ttl(ttlMs);
    const process = await currentProcessInstance();
    await this.#authorize(subject, 'acquire');
    const key = resourceKey(subject);
    // A CAS conflict is a meaningful concurrency outcome, not a reason to
    // reuse another worker's token or automatically replay its side effects.
    const current = await this.#store.get(NS, key);
    const now = this.#clock().getTime();
    const previous = parseValue(current);
    if (previous && previous.kind === 'revoked' && subject.authorityGeneration <= previous.revokedGeneration) {
      throw blocked('REMOTE_AUTHORITY_REVOKED', 'Account-device generation has been revoked.');
    }
    if (previous && previous.kind === 'active' && Date.parse(current!.expiresAt ?? '') > now) {
      throw blocked('REMOTE_AUTHORITY_HELD', 'Another worker still holds this device generation.');
    }
    if (previous && (previous.kind === 'active' || previous.kind === 'released')) {
      if (subject.authorityGeneration < previous.authorityGeneration) {
        throw blocked('REMOTE_AUTHORITY_REVOKED', 'Device has a newer authority generation.');
      }
      // An expired lease can be reclaimed by its account, but a *different*
      // account must advance the authority generation. TTL is not proof that
      // a new tenant owns the cryptographic device registration.
      if (previous.accountId !== subject.accountId &&
          subject.authorityGeneration <= previous.authorityGeneration) {
        throw blocked('REMOTE_AUTHORITY_FOREIGN_OWNER', 'Expired device lease cannot transfer accounts at a reused generation.');
      }
    }
    const leaseId = crypto.randomUUID();
    const fenceToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now + ms).toISOString();
    const [written] = await this.#store.transact([{
      namespace: NS, key,
      expectedGeneration: current && current.expiresAt && Date.parse(current.expiresAt) <= now ? null : current?.generation ?? null,
      value: { kind: 'active', schemaVersion: 1, accountId: subject.accountId, deviceId: subject.deviceId,
        authorityGeneration: subject.authorityGeneration, ownerId, process, leaseId, fenceToken },
      expiresAt
    }], new Date(now).toISOString());
    return { schemaVersion: 1, ...subject, ownerId, process, leaseId, fenceToken, generation: written!.generation, expiresAt };
  }

  async assertCurrent(leaseInput: RemoteAuthorityLease): Promise<RemoteAuthorityLease> {
    const lease = validateLease(leaseInput);
    const record = await this.#store.get(NS, resourceKey(lease));
    const current = parseValue(record);
    if (!record || !current || current.kind !== 'active' ||
      !record.expiresAt || Date.parse(record.expiresAt) <= this.#clock().getTime() ||
      record.generation !== lease.generation ||
      current.accountId !== lease.accountId || current.deviceId !== lease.deviceId ||
      current.authorityGeneration !== lease.authorityGeneration || current.ownerId !== lease.ownerId ||
      current.leaseId !== lease.leaseId || !sameToken(current.fenceToken, lease.fenceToken) ||
      current.process.pid !== lease.process.pid || current.process.started !== lease.process.started) {
      throw blocked('REMOTE_AUTHORITY_FENCE_LOST', 'Remote authority ownership is stale, expired or revoked.');
    }
    // A durable lease is not permission by itself. Re-check the independently
    // authoritative account/device policy on every execution-boundary check,
    // including heartbeat and atomic provider commit paths using this method.
    // The generation CAS remains necessary for a revocation racing *after*
    // this policy check.
    await this.#authorize({ accountId: lease.accountId, deviceId: lease.deviceId,
      authorityGeneration: lease.authorityGeneration }, 'acquire');
    return { ...lease, expiresAt: record.expiresAt };
  }

  async heartbeat(leaseInput: RemoteAuthorityLease, ttlMs = 30_000): Promise<RemoteAuthorityLease> {
    await this.#assertExecutingOwner(leaseInput);
    const lease = await this.assertCurrent(leaseInput);
    const ms = ttl(ttlMs);
    const now = this.#clock().getTime();
    const expiresAt = new Date(now + ms).toISOString();
    const [renewed] = await this.#store.transact([{
      namespace: NS, key: resourceKey(lease),
      expectedGeneration: lease.generation,
      value: { kind: 'active', schemaVersion: 1, accountId: lease.accountId, deviceId: lease.deviceId,
        authorityGeneration: lease.authorityGeneration, ownerId: lease.ownerId,
        process: lease.process, leaseId: lease.leaseId, fenceToken: lease.fenceToken },
      expiresAt
    }], new Date(now).toISOString());
    return { ...lease, generation: renewed!.generation, expiresAt };
  }

  /**
   * Atomic provider commit for effects stored in the SAME ControlPlaneStore.
   * Compare the exact lease generation and commit the protected mutation in
   * one transaction. If revocation/heartbeat wins first, the provider write
   * is rolled back with CONTROL_PLANE_CAS_MISMATCH. This is not an external
   * side-effect wrapper: out-of-band filesystem/network writes still require
   * a provider-native prepare/commit and reconciliation protocol.
   *
   * The returned lease supersedes the input even for a protected deletion:
   * advancing the owner generation is necessary to fence concurrent writers.
   */
  async commitProtected(leaseInput: RemoteAuthorityLease, mutation: ControlPlaneMutation):
    Promise<{ lease: RemoteAuthorityLease; record: ControlPlaneRecord | null }> {
    await this.#assertExecutingOwner(leaseInput);
    const lease = await this.assertCurrent(leaseInput);
    if (!mutation || typeof mutation !== 'object' || mutation.namespace === NS) {
      throw blocked('REMOTE_AUTHORITY_INVALID', 'Protected mutation must not address the authority namespace.');
    }
    if (!this.#authorizeMutation) {
      throw blocked('REMOTE_AUTHORITY_MUTATION_POLICY_REQUIRED', 'Provider effect scope authorization is required before protected commit.');
    }
    // The mutation authorizer is trusted to verify exact account/device/resource
    // ownership, not just a caller-supplied label. This check may deny the
    // operation; the lease generation CAS still guards against revocation races.
    await this.#authorizeMutation(lease, mutation);
    const now = this.#clock().toISOString();
    const [advanced, committed] = await this.#store.transact([
      {
        namespace: NS, key: resourceKey(lease), expectedGeneration: lease.generation,
        value: { kind: 'active', schemaVersion: 1, accountId: lease.accountId,
          deviceId: lease.deviceId, authorityGeneration: lease.authorityGeneration,
          ownerId: lease.ownerId, process: lease.process, leaseId: lease.leaseId,
          fenceToken: lease.fenceToken },
        expiresAt: lease.expiresAt
      },
      mutation
    ], now);
    if (!advanced) {
      throw blocked('REMOTE_AUTHORITY_FENCE_LOST', 'Atomic authority checkpoint did not produce a new generation.');
    }
    return {
      lease: { ...lease, generation: advanced.generation },
      record: committed ?? null
    };
  }

  /** Voluntary exact-owner release. Revocation remains a separate, irreversible
   * generation barrier. A release keeps the key's CAS history as a tombstone.
   */
  async release(leaseInput: RemoteAuthorityLease): Promise<void> {
    await this.#assertExecutingOwner(leaseInput);
    const lease = await this.assertCurrent(leaseInput);
    await this.#store.transact([{
      namespace: NS, key: resourceKey(lease),
      expectedGeneration: lease.generation,
      // Keep immutable tenant/generation lineage after voluntary release.
      // A tombstone-only DELETE preserves CAS but forgets which account owned
      // the device, allowing an unrelated account to reuse the generation.
      value: { kind: 'released', schemaVersion: 1, accountId: lease.accountId,
        deviceId: lease.deviceId, authorityGeneration: lease.authorityGeneration }
    }], this.#clock().toISOString());
  }

  /**
   * Independent providers can read-check a received lease via assertCurrent,
   * but only its exact originating OS process may renew, voluntarily release,
   * or make owner-authorized writes. A copied lease is not delegated authority.
   * Cross-host delegation must acquire a new generation-bound owner lease
   * under a trusted principal, never reuse a bearer from a different process.
   */
  async #assertExecutingOwner(leaseInput: RemoteAuthorityLease): Promise<void> {
    const lease = validateLease(leaseInput);
    let actual: ProcessInstanceIdentity;
    try { actual = await currentProcessInstance(); }
    catch { throw blocked('REMOTE_AUTHORITY_PROCESS_UNKNOWN', 'Executing process identity cannot be verified.'); }
    if (!sameProcessInstance(lease.process, actual)) {
      throw blocked('REMOTE_AUTHORITY_PROCESS_MISMATCH', 'Authority lease belongs to a different process instance.');
    }
  }

  async revoke(subjectInput: RemoteAuthoritySubject): Promise<RemoteAuthorityBarrier> {
    const subject = validateSubject(subjectInput);
    await this.#authorize(subject, 'revoke');
    const key = resourceKey(subject);
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await this.#store.get(NS, key);
      const previous = parseValue(current);
      // A stale administrator must not revoke a newer live authority incarnation.
      if (previous && (previous.kind === 'active' || previous.kind === 'released')) {
        if (previous.authorityGeneration > subject.authorityGeneration) {
          throw blocked('REMOTE_AUTHORITY_NEWER_GENERATION', 'Revocation would fence a newer device owner.');
        }
        if (previous.accountId !== subject.accountId) {
          throw blocked('REMOTE_AUTHORITY_FOREIGN_OWNER', 'Device authority belongs to a different account.');
        }
      }
      if (previous && previous.kind === 'revoked') {
        if (previous.revokedGeneration > subject.authorityGeneration) {
          throw blocked('REMOTE_AUTHORITY_NEWER_GENERATION', 'A newer authority has already been revoked.');
        }
        // A generation claim is not proof of a completed tenant transfer.
        // A different account must first acquire a new, strictly advanced
        // active lease through the trusted registration authority. Otherwise
        // its revoke call could erase another tenant's durable revocation
        // barrier without ever owning this device.
        if (previous.accountId !== subject.accountId) {
          throw blocked('REMOTE_AUTHORITY_FOREIGN_OWNER', 'Revocation cannot rewrite a different account\'s generation barrier.');
        }
      }
      const revokedGeneration = Math.max(subject.authorityGeneration,
        previous?.kind === 'revoked' ? previous.revokedGeneration : 0,
        previous?.kind === 'active' || previous?.kind === 'released' ? previous.authorityGeneration : 0);
      const now = this.#clock().toISOString();
      try {
        const [written] = await this.#store.transact([{
          namespace: NS, key,
          expectedGeneration: current && current.expiresAt && Date.parse(current.expiresAt) <= Date.parse(now) ? null : current?.generation ?? null,
          value: { kind: 'revoked', schemaVersion: 1, accountId: subject.accountId, deviceId: subject.deviceId, revokedGeneration }
        }], now);
        return { schemaVersion: 1, ...subject, revokedGeneration, generation: written!.generation };
      } catch (error) {
        if (!(error instanceof OperatorError) || error.code !== 'CONTROL_PLANE_CAS_MISMATCH') throw error;
      }
    }
    throw blocked('REMOTE_AUTHORITY_CONTENTION', 'Revocation could not establish an atomic authority barrier.');
  }
}

function validateSubject(input: RemoteAuthoritySubject): RemoteAuthoritySubject {
  if (!input || typeof input !== 'object') throw blocked('REMOTE_AUTHORITY_INVALID', 'Missing authority subject.');
  const accountId = String(input.accountId ?? '').toLowerCase(), deviceId = String(input.deviceId ?? '').toLowerCase();
  const authorityGeneration = input.authorityGeneration;
  if (!UUID.test(accountId) || !UUID.test(deviceId) || !Number.isSafeInteger(authorityGeneration) || authorityGeneration < 1) {
    throw blocked('REMOTE_AUTHORITY_INVALID', 'Invalid account, device or generation.');
  }
  return { accountId, deviceId, authorityGeneration };
}
function resourceKey(subject: RemoteAuthoritySubject): string { return subject.deviceId; }
function owner(value: string): string {
  if (typeof value !== 'string' || !OWNER.test(value)) throw blocked('REMOTE_AUTHORITY_INVALID', 'Invalid owner identity.');
  return value;
}
function ttl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) throw blocked('REMOTE_AUTHORITY_INVALID', 'Invalid lease TTL.');
  return value;
}
function validateLease(input: RemoteAuthorityLease): RemoteAuthorityLease {
  const subject = validateSubject(input);
  const process = validProcessInstance(input.process);
  if (input.schemaVersion !== 1 || !process || !UUID.test(String(input.leaseId ?? '')) ||
    !/^[A-Za-z0-9_-]{43}$/.test(String(input.fenceToken ?? '')) ||
    !Number.isSafeInteger(input.generation) || input.generation < 1 ||
    !Number.isFinite(Date.parse(String(input.expiresAt ?? '')))) {
    throw blocked('REMOTE_AUTHORITY_INVALID', 'Invalid work lease.');
  }
  return { ...subject, schemaVersion: 1, process, ownerId: owner(input.ownerId),
    leaseId: input.leaseId, fenceToken: input.fenceToken, generation: input.generation, expiresAt: input.expiresAt };
}
type LeaseState =
  | { kind: 'active'; accountId: string; deviceId: string; authorityGeneration: number; ownerId: string; process: ProcessInstanceIdentity; leaseId: string; fenceToken: string }
  | { kind: 'revoked'; accountId: string; deviceId: string; revokedGeneration: number }
  | { kind: 'released'; accountId: string; deviceId: string; authorityGeneration: number };
function parseValue(record: ControlPlaneRecord | null): LeaseState | null {
  if (!record) return null;
  const v = record.value;
  if (v.schemaVersion !== 1) throw blocked('REMOTE_AUTHORITY_CORRUPT', 'Authority record has an unknown schema.');
  if (v.kind === 'revoked' && Number.isSafeInteger(Number(v.revokedGeneration)) && Number(v.revokedGeneration) >= 1) {
    const subject = validateSubject({ accountId: String(v.accountId ?? ''), deviceId: String(v.deviceId ?? ''),
      authorityGeneration: Number(v.revokedGeneration) });
    if (subject.deviceId !== record.key) {
      throw blocked('REMOTE_AUTHORITY_CORRUPT', 'Revocation barrier does not match its device key.');
    }
    return { kind: 'revoked', accountId: subject.accountId, deviceId: subject.deviceId,
      revokedGeneration: subject.authorityGeneration };
  }
  if (v.kind === 'released') {
    const subject = validateSubject({ accountId: String(v.accountId ?? ''),
      deviceId: String(v.deviceId ?? ''), authorityGeneration: Number(v.authorityGeneration) });
    if (subject.deviceId !== record.key) {
      throw blocked('REMOTE_AUTHORITY_CORRUPT', 'Released authority record does not match its device key.');
    }
    return { kind: 'released', ...subject };
  }
  if (v.kind === 'active') {
    const subject = validateSubject({ accountId: String(v.accountId), deviceId: String(v.deviceId), authorityGeneration: Number(v.authorityGeneration) });
    const process = validProcessInstance(v.process);
    if (subject.deviceId !== record.key || !process || !UUID.test(String(v.leaseId)) ||
      typeof v.ownerId !== 'string' || !OWNER.test(v.ownerId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(v.fenceToken ?? ''))) {
      throw blocked('REMOTE_AUTHORITY_CORRUPT', 'Active authority record is malformed.');
    }
    return { kind: 'active', ...subject, ownerId: v.ownerId, process, leaseId: String(v.leaseId), fenceToken: String(v.fenceToken) };
  }
  throw blocked('REMOTE_AUTHORITY_CORRUPT', 'Unknown authority record state.');
}
function sameToken(a: string, b: string): boolean {
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function blocked(code: string, message: string): OperatorError {
  return new OperatorError(code, message, { retryable: false });
}
