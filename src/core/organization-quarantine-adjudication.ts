import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { DurableCompensationJournal } from './compensation-journal.ts';
import { stableOrganizationMissionId, organizationCompensationIntentId } from './organization-identity.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ENTRIES = 10_000;
const OPTIONS = { maxBytes: 8 * 1024 * 1024, errorCode: 'QUARANTINE_LEDGER_CORRUPT', invalidMessage: 'Quarantine ledger is corrupt.' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL = /^[A-Za-z0-9._:@/+=-]{1,256}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type QuarantineClassification = 'verified-owned' | 'verified-unrelated' | 'verified-never-created' | 'unresolved';
export interface ProviderQuarantineClaim {
  schemaVersion: 1;
  intentId: string;
  programId: string;
  targetKey: string;
  expectedMissionId: string;
  returnedMissionId: string;
  classification: QuarantineClassification;
  /** Independent provider creation-origin evidence digest. */
  evidenceDigest: string;
  /** Authoritative provider device/process/session and revocable generation. */
  providerDeviceId: string;
  providerProcessId: string;
  providerSessionId: string;
  authorityGeneration: number;
  issuedAt: string;
  expiresAt: string;
}
export interface SignedProviderQuarantineClaim { claim: ProviderQuarantineClaim; signature: string; }
export interface QuarantineAdjudicationInput {
  intentId: string; programId: string; targetKey: string;
  expectedMissionId: string; returnedMissionId: string; operatorId: string;
  providerClaim: SignedProviderQuarantineClaim;
}
export interface QuarantineAdjudicationRecord {
  schemaVersion: 1; intentId: string; programId: string; targetKey: string;
  returnedMissionId: string; classification: QuarantineClassification;
  evidenceDigest: string; operatorId: string; providerSignatureDigest: string;
  adjudicatedAt: string; previousMac: string; mac: string;
}
interface Ledger { version: 1; records: QuarantineAdjudicationRecord[]; }

/**
 * Only pinned provider signatures AND an independently authenticated scoped
 * operator can classify a returned child identity. Classification never grants
 * permission to cancel it; verified-owned stays in quarantine until a separate
 * provider-atomic effect and terminal receipt are obtained. UNKNOWN fails closed.
 */
export class OrganizationQuarantineAdjudicator {
  #file: string;
  #journal: DurableCompensationJournal;
  #providerPublicKeyPem: string;
  #ledgerSecret: Buffer;
  #authorize: (operatorId: string, claim: ProviderQuarantineClaim) => Promise<void>;
  #clock: () => Date;

  constructor(stateDir: string, options: {
    journal?: DurableCompensationJournal;
    providerPublicKeyPem: string;
    ledgerSecret: Buffer;
    authorize: (operatorId: string, claim: ProviderQuarantineClaim) => Promise<void>;
    clock?: () => Date;
  }) {
    if (!options || typeof options.authorize !== 'function' ||
        !Buffer.isBuffer(options.ledgerSecret) || options.ledgerSecret.length < 32) {
      throw invalid('Quarantine decisions require a trusted authorization policy and strong ledger MAC secret.');
    }
    let key: crypto.KeyObject;
    try { key = crypto.createPublicKey(options.providerPublicKeyPem); }
    catch { throw invalid('Provider public signing key is invalid.'); }
    if (key.asymmetricKeyType !== 'ed25519') throw invalid('An Ed25519 provider signing key is required.');
    this.#providerPublicKeyPem = options.providerPublicKeyPem;
    this.#ledgerSecret = Buffer.from(options.ledgerSecret);
    this.#authorize = options.authorize;
    this.#clock = options.clock ?? (() => new Date());
    this.#file = path.join(path.resolve(stateDir), 'quarantine-adjudications.json');
    this.#journal = options.journal ?? new DurableCompensationJournal(stateDir, { clock: this.#clock });
  }

  async review(input: QuarantineAdjudicationInput): Promise<QuarantineAdjudicationRecord> {
    const claim = validateClaim(input.providerClaim?.claim);
    const operatorId = label(input.operatorId, 'operatorId');
    if (claim.intentId !== label(input.intentId, 'intentId') ||
        claim.programId !== uuid(input.programId) ||
        claim.targetKey !== label(input.targetKey, 'targetKey') ||
        claim.expectedMissionId !== uuid(input.expectedMissionId) ||
        claim.returnedMissionId !== uuid(input.returnedMissionId)) {
      throw invalid('Signed provider claim does not match the exact recovery identity.');
    }
    if (claim.expectedMissionId !== stableOrganizationMissionId(claim.programId, claim.targetKey)) {
      throw invalid('Provider origin claim does not identify the deterministic child for this program and target.');
    }
    const now = this.#clock().getTime();
    const issued = Date.parse(claim.issuedAt), expires = Date.parse(claim.expiresAt);
    const signature = String(input.providerClaim.signature ?? '');
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature) ||
        !crypto.verify(null, Buffer.from(JSON.stringify(claim), 'utf8'),
          this.#providerPublicKeyPem, Buffer.from(signature, 'base64url'))) {
      throw invalid('Independent provider origin signature failed verification.');
    }
    // A crash can occur AFTER the signed decision is durably recorded but
    // BEFORE the matching quarantine journal entry is retired. A retry using
    // the exact previously committed signed evidence is a recovery operation:
    // it may be older than the ordinary five-minute initial-evidence window,
    // but it still needs a fresh operator authorization below. A new decision
    // with stale evidence is NEVER allowed.
    const signatureDigest = crypto.createHash('sha256').update(signature).digest('hex');
    const existingDecision = (await this.#read()).records.find((entry) => entry.intentId === claim.intentId);
    const sameCommittedDecision = existingDecision && matchesCommittedDecision(existingDecision, claim, operatorId, signatureDigest);
    if (!(issued <= now && now < expires && expires - issued <= 5 * 60_000) && !sameCommittedDecision) {
      throw invalid('Provider attestation is stale, premature or unbounded.');
    }
    await this.#authorize(operatorId, claim);
    if (claim.classification === 'unresolved') {
      throw new OperatorError('QUARANTINE_UNRESOLVED', 'Unresolved provider origin cannot be adjudicated.');
    }
    const intents = await this.#journal.pending('organization');
    const quarantine = intents.find((item) => item.id === claim.intentId &&
      item.ownerId === claim.programId && item.subjectKey === claim.targetKey &&
      item.operation === 'reconcile-untrusted-team-identity' && item.targetId === claim.returnedMissionId);
    if (!quarantine) {
      const ledger = await this.#read();
      const already = ledger.records.find((entry) => entry.intentId === claim.intentId);
      if (already) {
        if (!matchesCommittedDecision(already, claim, operatorId, signatureDigest)) {
          throw new OperatorError('QUARANTINE_ADJUDICATION_CONFLICT', 'Existing decision has a different authority or evidence contract.');
        }
        return already;
      }
      throw new OperatorError('QUARANTINE_NOT_FOUND', 'Matching unresolved recovery quarantine is absent.');
    }
    // Require the original *preallocated* recovery contract as independent
    // evidence that this quarantine is tied to a real creation attempt.
    // A signed provider classification plus an arbitrary returned ID does
    // not create recovery ownership when that prepare was never persisted.
    const originalIntentId = organizationCompensationIntentId(claim.programId,
      'cancel-team-mission', claim.expectedMissionId);
    const original = intents.find((item) => item.id === originalIntentId &&
      item.ownerKind === 'organization' && item.ownerId === claim.programId &&
      item.subjectKey === claim.targetKey &&
      item.operation === 'cancel-team-mission' &&
      item.targetId === claim.expectedMissionId);
    if (!original) {
      throw new OperatorError('QUARANTINE_ORIGIN_UNVERIFIED',
        'Original deterministic child creation intent is absent or misbound; quarantine must remain unresolved.');
    }
    // A verified foreign identity may be retired as a *quarantine label*, but
    // the separate original write-ahead child intent remains intact. A claim
    // about the returned ID does not prove the expected ID was never created.
    const record = await withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const existing = state.records.find((item) => item.intentId === claim.intentId);
      if (existing) {
        if (!matchesCommittedDecision(existing, claim, operatorId, signatureDigest)) {
          throw new OperatorError('QUARANTINE_ADJUDICATION_CONFLICT', 'This intent has an immutable different disposition.');
        }
        return existing;
      }
      if (state.records.length >= MAX_ENTRIES) throw invalid('Quarantine decision ledger capacity exhausted.');
      const previousMac = state.records.at(-1)?.mac ?? '0'.repeat(64);
      const base = { schemaVersion: 1 as const, intentId: claim.intentId, programId: claim.programId,
        targetKey: claim.targetKey, returnedMissionId: claim.returnedMissionId,
        classification: claim.classification, evidenceDigest: claim.evidenceDigest,
        operatorId, providerSignatureDigest: signatureDigest,
        adjudicatedAt: this.#clock().toISOString(), previousMac };
      const entry = { ...base, mac: this.#mac(base) };
      state.records.push(entry);
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
      return entry;
    });
    // Preserve verified-owned cases: a proved origin isn't itself proof that
    // a cancellation was authorized, safely committed or terminal.
    if (record.classification !== 'verified-owned') {
      await this.#authorize(operatorId, claim);
      await this.#journal.complete(claim.intentId);
    }
    return record;
  }

  async list(): Promise<QuarantineAdjudicationRecord[]> {
    return (await this.#read()).records.map((entry) => structuredClone(entry));
  }

  async #read(): Promise<Ledger> {
    let parsed: Ledger;
    try { parsed = JSON.parse(await readDurableStateText(this.#file, OPTIONS)) as Ledger; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('QUARANTINE_LEDGER_CORRUPT', 'Quarantine decision ledger cannot be read.');
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > MAX_ENTRIES) {
      throw new OperatorError('QUARANTINE_LEDGER_CORRUPT', 'Quarantine decision ledger shape is invalid.');
    }
    let previousMac = '0'.repeat(64);
    const seen = new Set<string>();
    for (const record of parsed.records) {
      const { mac, ...base } = record;
      if (record.schemaVersion !== 1 || seen.has(record.intentId) ||
          record.previousMac !== previousMac || !DIGEST.test(String(mac)) ||
          !constantHexEqual(mac, this.#mac(base))) {
        throw new OperatorError('QUARANTINE_LEDGER_CORRUPT', 'Quarantine decision provenance or MAC chain was modified.');
      }
      seen.add(record.intentId);
      previousMac = mac;
    }
    return parsed;
  }

  #mac(base: Omit<QuarantineAdjudicationRecord, 'mac'>): string {
    return crypto.createHmac('sha256', this.#ledgerSecret).update(JSON.stringify(base)).digest('hex');
  }
}
function matchesCommittedDecision(
  record: QuarantineAdjudicationRecord, claim: ProviderQuarantineClaim,
  operatorId: string, signatureDigest: string
): boolean {
  return record.intentId === claim.intentId && record.programId === claim.programId &&
    record.targetKey === claim.targetKey && record.returnedMissionId === claim.returnedMissionId &&
    record.operatorId === operatorId && record.classification === claim.classification &&
    record.evidenceDigest === claim.evidenceDigest && record.providerSignatureDigest === signatureDigest;
}
function constantHexEqual(a: string, b: string): boolean {
  if (!DIGEST.test(a) || !DIGEST.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function validateClaim(input: ProviderQuarantineClaim): ProviderQuarantineClaim {
  if (!input || input.schemaVersion !== 1) throw invalid('Unsupported provider attestation.');
  const classification = input.classification;
  if (!['verified-owned','verified-unrelated','verified-never-created','unresolved'].includes(classification)) {
    throw invalid('Provider classification is invalid.');
  }
  const generation = input.authorityGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1) throw invalid('Invalid provider authority generation.');
  const issuedAt = iso(input.issuedAt), expiresAt = iso(input.expiresAt);
  if (!DIGEST.test(String(input.evidenceDigest))) throw invalid('Provider evidence digest is invalid.');
  return { schemaVersion: 1, intentId: label(input.intentId,'intentId'),
    programId: uuid(input.programId), targetKey: label(input.targetKey,'targetKey'),
    expectedMissionId: uuid(input.expectedMissionId), returnedMissionId: uuid(input.returnedMissionId),
    classification, evidenceDigest: input.evidenceDigest,
    providerDeviceId: uuid(input.providerDeviceId),
    providerProcessId: label(input.providerProcessId,'providerProcessId'),
    providerSessionId: uuid(input.providerSessionId),
    authorityGeneration: generation, issuedAt, expiresAt };
}
function iso(input: unknown): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw invalid('Provider timestamp must be canonical UTC.');
  return input;
}
function uuid(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) throw invalid('Origin identity must be a UUID.');
  return input.toLowerCase();
}
function label(input: unknown, field: string): string {
  if (typeof input !== 'string' || !LABEL.test(input)) throw invalid(field + ' is invalid.');
  return input;
}
function invalid(message: string): OperatorError {
  return new OperatorError('QUARANTINE_EVIDENCE_INVALID', message, { retryable: false });
}
