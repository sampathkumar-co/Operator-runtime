import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { ArtifactStore, type ArtifactPrivacy, type ArtifactRecord } from './artifact-store.ts';
import { normalizeExecutionContextIdentity, executionContextDigest, type ExecutionContextIdentity } from './execution-context-identity.ts';
import { OperatorError } from './errors.ts';

export type ProofLevel =
  | 'PROVEN'
  | 'EMPIRICALLY_VERIFIED'
  | 'CORROBORATED'
  | 'INFERRED'
  | 'UNKNOWN'
  | 'CONTRADICTED';

export interface EvidencePackClaim {
  id: string;
  statement: string;
  level: ProofLevel;
  artifactIds: string[];
  verifier?: string;
}

export interface EvidencePack {
  schemaVersion: 1;
  id: string;
  executionContext: ExecutionContextIdentity;
  executionContextDigest: string;
  artifactIds: string[];
  claims: EvidencePackClaim[];
  residualUncertainty: string[];
  rollbackStatus: 'NOT_APPLICABLE' | 'AVAILABLE' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  createdAt: string;
}

export function createEvidencePack(input: {
  executionContext: ExecutionContextIdentity;
  artifactIds: string[];
  claims: EvidencePackClaim[];
  residualUncertainty?: string[];
  rollbackStatus?: EvidencePack['rollbackStatus'];
  now?: string;
}): EvidencePack {
  const executionContext = normalizeExecutionContextIdentity(input.executionContext);
  const contextDigest = executionContextDigest(executionContext);
  const artifactIds = uniqueDigests(input.artifactIds, 'artifactIds');
  if (artifactIds.length < 1) throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack requires at least one artifact.');
  const artifactSet = new Set(artifactIds);
  const claims = normalizeClaims(input.claims, artifactSet);
  const residualUncertainty = uniqueBoundedText(input.residualUncertainty ?? [], 100, 4096, 'residualUncertainty');
  const rollbackStatus = normalizeRollbackStatus(input.rollbackStatus ?? 'UNKNOWN');
  const createdAt = canonicalIso(input.now ?? new Date().toISOString());
  const identity = {
    schemaVersion: 1 as const,
    executionContext,
    executionContextDigest: contextDigest,
    artifactIds,
    claims,
    residualUncertainty,
    rollbackStatus
  };
  const id = crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
  return { ...identity, id, createdAt };
}

export async function publishEvidencePack(
  store: ArtifactStore,
  input: Parameters<typeof createEvidencePack>[0],
  privacy: ArtifactPrivacy = 'internal'
): Promise<{ pack: EvidencePack; artifact: ArtifactRecord }> {
  const pack = createEvidencePack(input);
  // A content address only establishes the record's identity. It cannot
  // authorize reusing evidence from another task, plan, principal, or device.
  // Metadata-only get() checks immutable content-addressed record identity
  // without materializing up to 64 MiB of unrelated artifact bytes.
  const privacyRank: Record<ArtifactPrivacy, number> = { public: 0, internal: 1, sensitive: 2 };
  for (const artifactId of pack.artifactIds) {
    const record = await store.get(artifactId);
    if (record.executionContextDigest !== pack.executionContextDigest) {
      throw new OperatorError('EVIDENCE_PACK_CONTEXT_MISMATCH',
        'Evidence Pack cannot attach an unbound artifact or evidence from a different execution context.');
    }
    if (privacyRank[record.privacy] > privacyRank[privacy]) {
      throw new OperatorError('EVIDENCE_PACK_PRIVACY_DOWNGRADE',
        'Evidence Pack privacy cannot be less restrictive than its referenced evidence.');
    }
  }
  const artifact = await store.put({
    bytes: JSON.stringify(pack, null, 2),
    kind: 'evidence-pack',
    mediaType: 'application/json',
    privacy,
    executionContextDigest: pack.executionContextDigest,
    metadata: {
      evidencePackId: pack.id,
      claimCount: pack.claims.length,
      artifactCount: pack.artifactIds.length
    },
    now: pack.createdAt
  });
  return { pack, artifact };
}

/**
 * Proof-bearing lists must be exact JSON arrays. Array.map() skips holes;
 * indexing inherited getters also executes untrusted code before validation.
 * Snapshot only enumerable own data values, and reject extra/hidden fields.
 */
function inertList(input: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < min || input.length > max ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', label + ' must be an exact bounded array.');
  }
  const values: unknown[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(input, String(i));
    if (!slot || !slot.enumerable || !('value' in slot)) {
      throw new OperatorError('EVIDENCE_PACK_INVALID', label + ' must contain inert own data entries.');
    }
    values.push(slot.value);
  }
  return values;
}

function inertClaim(raw: unknown): Record<'id' | 'statement' | 'level' | 'artifactIds' | 'verifier', unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack claim must be an inert plain object.');
  }
  const allowed = ['id', 'statement', 'level', 'artifactIds', 'verifier'];
  const mandatory = ['id', 'statement', 'level', 'artifactIds'];
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      mandatory.some(key => !Object.hasOwn(descriptors, key))) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack claim has missing or unsupported fields.');
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack claim contains an executable or hidden property.');
    }
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, desc]) => [key, desc.value])) as
    Record<'id' | 'statement' | 'level' | 'artifactIds' | 'verifier', unknown>;
}

function normalizeClaims(input: unknown, artifactSet: Set<string>): EvidencePackClaim[] {
  const items = inertList(input, 1, 500, 'Evidence Pack claims');
  const ids = new Set<string>();
  return items.map((raw) => {
    const value = inertClaim(raw);
    const id = boundedId(value.id, 'claim id');
    if (ids.has(id)) throw new OperatorError('EVIDENCE_PACK_INVALID', `Duplicate claim id: ${id}.`);
    ids.add(id);
    const statement = boundedText(value.statement, 8192, 'claim statement');
    const level = normalizeProofLevel(value.level);
    const artifactIds = uniqueDigests(value.artifactIds, 'claim artifactIds');
    if (level === 'PROVEN' || level === 'EMPIRICALLY_VERIFIED' || level === 'CORROBORATED' || level === 'CONTRADICTED') {
      if (artifactIds.length < 1) throw new OperatorError('EVIDENCE_PACK_INVALID', `Claim ${id} requires evidence artifacts for level ${level}.`);
    }
    for (const artifactId of artifactIds) {
      if (!artifactSet.has(artifactId)) {
        throw new OperatorError('EVIDENCE_PACK_INVALID', `Claim ${id} references artifact outside the Evidence Pack.`);
      }
    }
    const verifier = value.verifier === undefined ? undefined : boundedText(value.verifier, 256, 'claim verifier');
    return { id, statement, level, artifactIds, ...(verifier ? { verifier } : {}) };
  });
}

function normalizeProofLevel(value: unknown): ProofLevel {
  const allowed: ProofLevel[] = ['PROVEN', 'EMPIRICALLY_VERIFIED', 'CORROBORATED', 'INFERRED', 'UNKNOWN', 'CONTRADICTED'];
  if (typeof value !== 'string' || !allowed.includes(value as ProofLevel)) throw new OperatorError('EVIDENCE_PACK_INVALID', 'Claim proof level is invalid.');
  return value as ProofLevel;
}

function normalizeRollbackStatus(value: unknown): EvidencePack['rollbackStatus'] {
  const allowed: EvidencePack['rollbackStatus'][] = ['NOT_APPLICABLE', 'AVAILABLE', 'COMPLETED', 'FAILED', 'UNKNOWN'];
  if (typeof value !== 'string' || !allowed.includes(value as EvidencePack['rollbackStatus'])) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack rollback status is invalid.');
  }
  return value as EvidencePack['rollbackStatus'];
}

function uniqueDigests(input: unknown, label: string): string[] {
  const entries = inertList(input, 0, 5000, label);
  const values: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !/^[0-9a-f]{64}$/i.test(entry)) {
      throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} contains an invalid literal digest.`);
    }
    values.push(entry.toLowerCase());
  }
  return [...new Set(values)].sort();
}

function uniqueBoundedText(input: unknown, maxItems: number, maxBytes: number, label: string): string[] {
  const entries = inertList(input, 0, maxItems, label);
  return [...new Set(entries.map(value => boundedText(value, maxBytes, label)))];
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} must be a literal bounded identifier.`);
  }
  return value;
}

function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} is invalid.`);
  }
  return value;
}

function canonicalIso(value: unknown): string {
  if (typeof value !== 'string' || !value ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack timestamp must be a literal canonical ISO string.');
  }
  return value;
}
