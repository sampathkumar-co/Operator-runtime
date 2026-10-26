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

function normalizeClaims(input: unknown, artifactSet: Set<string>): EvidencePackClaim[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 500) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack requires 1-500 claims.');
  }
  const ids = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack claim must be an object.');
    const value = raw as Record<string, unknown>;
    const id = boundedId(value.id, 'claim id');
    if (ids.has(id)) throw new OperatorError('EVIDENCE_PACK_INVALID', `Duplicate claim id: ${id}`);
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
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > 5000 || Object.keys(input).length !== input.length) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} must be a dense bounded array.`);
  }
  const values: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index) || typeof input[index] !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(input[index])) {
      throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} contains an invalid literal digest.`);
    }
    values.push(input[index].toLowerCase());
  }
  return [...new Set(values)].sort();
}

function uniqueBoundedText(input: unknown, maxItems: number, maxBytes: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} is invalid.`);
  const values = input.map((value) => boundedText(value, maxBytes, label));
  return [...new Set(values)];
}

function boundedId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} is invalid.`);
  return text;
}

function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', `${label} is invalid.`);
  }
  return value;
}

function canonicalIso(value: unknown): string {
  const text = String(value ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new OperatorError('EVIDENCE_PACK_INVALID', 'Evidence Pack timestamp must be canonical ISO.');
  }
  return text;
}
