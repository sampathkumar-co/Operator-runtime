import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { evaluateProofClaim, type ProofEvidenceRef, type ProofKernelDecision } from './proof-kernel.ts';

export interface ProofBundleClaim {
  id: string;
  statementDigest: string;
  required: boolean;
  decision: ProofKernelDecision;
}

export interface ProofBundleSignature {
  algorithm: 'ed25519';
  keyId: string;
  signatureBase64: string;
}

export interface MachineVerifiableProofBundle {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  authorityDigest: string;
  planDigest: string;
  effectJournalDigest: string;
  evidencePackId: string;
  claims: ProofBundleClaim[];
  residualUncertainty: string[];
  rollbackStatus: 'NOT_REQUIRED' | 'AVAILABLE' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  createdAt: string;
  signature?: ProofBundleSignature;
}

export interface ProofBundleVerification {
  status: 'VALID' | 'INVALID' | 'UNSIGNED';
  bundleId: string;
  reasons: string[];
  requiredClaimsSatisfied: boolean;
  signatureVerified: boolean;
}

export function createProofBundleClaim(input: {
  statement: string;
  required?: boolean;
  evidence: ProofEvidenceRef[];
  inferred?: boolean;
}): ProofBundleClaim {
  const statement = boundedText(input.statement, 16 * 1024, 'statement');
  const decision = evaluateProofClaim({ evidence: input.evidence, inferred: input.inferred });
  const statementDigest = sha256(statement);
  const identity = {
    statementDigest,
    required: input.required ?? false,
    decision
  };
  return {
    id: sha256(canonicalJson(identity)),
    ...identity
  };
}

export function createMachineVerifiableProofBundle(input: {
  objectiveId: string;
  authorityDigest: string;
  planDigest: string;
  effectJournalDigest: string;
  evidencePackId: string;
  claims: ProofBundleClaim[];
  residualUncertainty?: string[];
  rollbackStatus?: MachineVerifiableProofBundle['rollbackStatus'];
  createdAt?: string;
}): MachineVerifiableProofBundle {
  const body = normalizeBody({
    objectiveId: input.objectiveId,
    authorityDigest: input.authorityDigest,
    planDigest: input.planDigest,
    effectJournalDigest: input.effectJournalDigest,
    evidencePackId: input.evidencePackId,
    claims: input.claims,
    residualUncertainty: input.residualUncertainty ?? [],
    rollbackStatus: input.rollbackStatus ?? 'UNKNOWN',
    createdAt: input.createdAt ?? new Date().toISOString()
  });
  return {
    schemaVersion: 1,
    id: sha256(canonicalJson(body)),
    ...body
  };
}

export function signMachineVerifiableProofBundle(
  bundleInput: MachineVerifiableProofBundle,
  input: { keyId: string; privateKeyPem: string }
): MachineVerifiableProofBundle {
  const bundle = validateBundleShape(bundleInput);
  if (bundle.signature) throw invalid('Proof bundle is already signed.');
  const keyId = id(input.keyId, 'keyId');
  if (typeof input.privateKeyPem !== 'string' || !input.privateKeyPem.includes('PRIVATE KEY')) throw invalid('Private signing key is invalid.');
  const payload = canonicalJson(unsignedPayload(bundle));
  let signature: Buffer;
  try {
    signature = crypto.sign(null, Buffer.from(payload, 'utf8'), input.privateKeyPem);
  } catch {
    throw invalid('Proof bundle signing failed.');
  }
  return {
    ...bundle,
    signature: {
      algorithm: 'ed25519',
      keyId,
      signatureBase64: signature.toString('base64')
    }
  };
}

export function verifyMachineVerifiableProofBundle(
  bundleInput: MachineVerifiableProofBundle,
  trustedPublicKeys: Readonly<Record<string, string>> = {}
): ProofBundleVerification {
  let bundle: MachineVerifiableProofBundle;
  try {
    bundle = validateBundleShape(bundleInput);
  } catch (error) {
    return {
      status: 'INVALID',
      bundleId: typeof bundleInput?.id === 'string' ? bundleInput.id : '',
      reasons: [error instanceof Error ? error.message : String(error)],
      requiredClaimsSatisfied: false,
      signatureVerified: false
    };
  }
  const reasons: string[] = [];
  const expectedId = sha256(canonicalJson(normalizeBody(bundle)));
  if (expectedId !== bundle.id) reasons.push('BUNDLE_DIGEST_MISMATCH');

  const requiredClaimsSatisfied = bundle.claims
    .filter((claim) => claim.required)
    .every((claim) => !['UNKNOWN','INFERRED','CONTRADICTED'].includes(claim.decision.level));
  if (!requiredClaimsSatisfied) reasons.push('REQUIRED_CLAIM_UNPROVEN');
  if (bundle.rollbackStatus === 'FAILED') reasons.push('ROLLBACK_FAILED');

  let signatureVerified = false;
  if (bundle.signature) {
    const key = trustedPublicKeys[bundle.signature.keyId];
    if (!key) reasons.push('SIGNING_KEY_UNTRUSTED');
    else {
      try {
        signatureVerified = crypto.verify(
          null,
          Buffer.from(canonicalJson(unsignedPayload(bundle)), 'utf8'),
          key,
          Buffer.from(bundle.signature.signatureBase64, 'base64')
        );
      } catch {
        signatureVerified = false;
      }
      if (!signatureVerified) reasons.push('SIGNATURE_INVALID');
    }
  }

  if (reasons.length > 0) {
    return {
      status: 'INVALID',
      bundleId: bundle.id,
      reasons,
      requiredClaimsSatisfied,
      signatureVerified
    };
  }
  if (!bundle.signature) {
    return {
      status: 'UNSIGNED',
      bundleId: bundle.id,
      reasons: ['SIGNATURE_MISSING'],
      requiredClaimsSatisfied,
      signatureVerified: false
    };
  }
  return {
    status: 'VALID',
    bundleId: bundle.id,
    reasons: [],
    requiredClaimsSatisfied,
    signatureVerified
  };
}

function validateBundleShape(input: MachineVerifiableProofBundle): MachineVerifiableProofBundle {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') throw invalid('Proof bundle shape is invalid.');
  const body = normalizeBody(input);
  const bundle: MachineVerifiableProofBundle = {
    schemaVersion: 1,
    id: digest(input.id, 'id'),
    ...body
  };
  if (input.signature !== undefined) {
    if (
      !input.signature ||
      input.signature.algorithm !== 'ed25519' ||
      !/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(input.signature.keyId) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.signature.signatureBase64) ||
      Buffer.from(input.signature.signatureBase64, 'base64').length !== 64
    ) throw invalid('Proof bundle signature is invalid.');
    bundle.signature = {
      algorithm: 'ed25519',
      keyId: input.signature.keyId,
      signatureBase64: input.signature.signatureBase64
    };
  }
  return bundle;
}

function normalizeBody(input: {
  objectiveId: string;
  authorityDigest: string;
  planDigest: string;
  effectJournalDigest: string;
  evidencePackId: string;
  claims: ProofBundleClaim[];
  residualUncertainty: string[];
  rollbackStatus: MachineVerifiableProofBundle['rollbackStatus'];
  createdAt: string;
}) {
  if (!Array.isArray(input.claims) || input.claims.length > 10_000) throw invalid('Proof bundle claims are invalid.');
  const claims = input.claims.map(normalizeClaim).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) throw invalid('Proof bundle claim ids must be unique.');
  if (!Array.isArray(input.residualUncertainty) || input.residualUncertainty.length > 1000) throw invalid('Residual uncertainty is invalid.');
  const residualUncertainty = [...new Set(input.residualUncertainty.map((item) => boundedText(item, 4096, 'residualUncertainty')))].sort();
  if (!['NOT_REQUIRED','AVAILABLE','COMPLETED','FAILED','UNKNOWN'].includes(input.rollbackStatus)) throw invalid('rollbackStatus is invalid.');
  return {
    objectiveId: id(input.objectiveId, 'objectiveId'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    planDigest: digest(input.planDigest, 'planDigest'),
    effectJournalDigest: digest(input.effectJournalDigest, 'effectJournalDigest'),
    evidencePackId: digest(input.evidencePackId, 'evidencePackId'),
    claims,
    residualUncertainty,
    rollbackStatus: input.rollbackStatus,
    createdAt: iso(input.createdAt, 'createdAt')
  };
}

function normalizeClaim(input: ProofBundleClaim): ProofBundleClaim {
  if (!input || typeof input !== 'object') throw invalid('Proof bundle claim is invalid.');
  const statementDigest = digest(input.statementDigest, 'statementDigest');
  if (typeof input.required !== 'boolean') throw invalid('Proof bundle claim required flag is invalid.');
  if (!input.decision || !['PROVEN','EMPIRICALLY_VERIFIED','CORROBORATED','INFERRED','UNKNOWN','CONTRADICTED'].includes(input.decision.level)) {
    throw invalid('Proof bundle claim decision is invalid.');
  }
  if (!Array.isArray(input.decision.artifactIds) || input.decision.artifactIds.length > 10_000) throw invalid('Proof bundle claim artifacts are invalid.');
  const artifactIds = [...new Set(input.decision.artifactIds.map((item) => digest(item, 'artifactId')))].sort();
  const reason = boundedText(input.decision.reason, 4096, 'decision.reason');
  const identity = {
    statementDigest,
    required: input.required,
    decision: { level: input.decision.level, artifactIds, reason }
  };
  const expected = sha256(canonicalJson(identity));
  if (digest(input.id, 'claim.id') !== expected) throw invalid('Proof bundle claim id does not match its content.');
  return { id: expected, ...identity };
}

function unsignedPayload(bundle: MachineVerifiableProofBundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    id: bundle.id,
    ...normalizeBody(bundle)
  };
}

function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) throw invalid(label + ' is invalid.');
  return input.trim();
}

function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): OperatorError {
  return new OperatorError('PROOF_BUNDLE_INVALID', message);
}
