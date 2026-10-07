import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';
import type { ProofLevel } from './evidence-pack.ts';
import { verifySignedProofBundle, type SignedProofBundle } from './proof-bundle.ts';
import { engineeringObjectiveNamespace, normalizeEngineeringObjective, type EngineeringObjectiveRecord } from './engineering-objective-lifecycle.ts';

export interface ProofAwarePlanCandidate {
  id: string;
  planDigest: string;
  authorityDigest: string;
  proofLevel: ProofLevel;
  uncertaintyScore: number;
  reversible: boolean;
  mutating: boolean;
  verificationObligations: string[];
  estimatedBlastRadius: number;
  predictedSuccess: number;
}

export interface ProofAwarePlanEvaluation {
  id: string;
  eligible: boolean;
  reasons: string[];
  score: number;
  planDigest: string;
}

export interface ProofAwarePlanDecision {
  schemaVersion: 1;
  objectiveId: string;
  authorityDigest: string;
  selectedPlanId: string;
  selectedPlanDigest: string;
  evaluations: ProofAwarePlanEvaluation[];
  decisionDigest: string;
}

export interface CanonicalAgentTrustEnvelope {
  schemaVersion: 1;
  vendor: string;
  agentStack: string;
  principalId: string;
  objectiveId: string;
  authorityDigest: string;
  planDigest: string;
  proofBundleDigest: string;
  lineageDigests: string[];
  evidenceDigests: string[];
  outcome: 'VERIFIED' | 'FAILED' | 'RECOVERY_REQUIRED';
  envelopeDigest: string;
}

export interface LearningCertificationWitness {
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  certificationDigest: string;
  authorityViolations: number;
  learningPolicyViolations: number;
  portableProof: boolean;
}

export interface LearnedEngineeringStrategy {
  schemaVersion: 1;
  strategyKey: string;
  contentDigest: string;
  sourceObjectiveIds: string[];
  proofBundleDigests: string[];
  certificationDigests: string[];
  verificationCount: number;
  updatedAt: string;
}

const PROOF_RANK: Readonly<Record<ProofLevel, number>> = {
  PROVEN: 1,
  EMPIRICALLY_VERIFIED: 0.95,
  CORROBORATED: 0.8,
  INFERRED: 0.35,
  UNKNOWN: 0,
  CONTRADICTED: -1
};
const NAMESPACE = engineeringObjectiveNamespace();

export function evaluateProofAwarePlans(
  objectiveInput: EngineeringObjectiveRecord,
  candidatesInput: ProofAwarePlanCandidate[]
): ProofAwarePlanDecision {
  const objective = normalizeEngineeringObjective(objectiveInput as unknown as Record<string, unknown>);
  if (!Array.isArray(candidatesInput) || candidatesInput.length < 1 || candidatesInput.length > 1000) {
    throw invalid('Plan candidates are invalid.');
  }
  const seen = new Set<string>();
  const evaluations = candidatesInput.map((input): ProofAwarePlanEvaluation => {
    const candidate = normalizeCandidate(input);
    if (seen.has(candidate.id)) throw invalid('Plan candidate IDs must be unique.');
    seen.add(candidate.id);
    const reasons: string[] = [];
    if (candidate.authorityDigest !== objective.authorityDigest) reasons.push('authority digest does not match objective');
    if (candidate.proofLevel === 'CONTRADICTED') reasons.push('candidate proof is contradicted');
    if (candidate.proofLevel === 'UNKNOWN') reasons.push('candidate proof is unknown');
    if (candidate.proofLevel === 'INFERRED') reasons.push('inference cannot authorize execution');
    if (candidate.mutating && !candidate.verificationObligations.includes('postcondition')) reasons.push('mutation lacks postcondition verification');
    if (!candidate.reversible) {
      if (!['PROVEN', 'EMPIRICALLY_VERIFIED'].includes(candidate.proofLevel)) reasons.push('irreversible candidate requires strong proof');
      if (candidate.uncertaintyScore > 0.05) reasons.push('irreversible candidate uncertainty exceeds 0.05');
      if (!candidate.verificationObligations.includes('independent-verifier')) reasons.push('irreversible candidate lacks independent verifier');
      if (!candidate.verificationObligations.includes('recovery-plan')) reasons.push('irreversible candidate lacks recovery plan');
    }
    const proofScore = Math.max(0, PROOF_RANK[candidate.proofLevel]);
    const reversibilityScore = candidate.reversible ? 1 : 0.4;
    const blastScore = 1 / (1 + candidate.estimatedBlastRadius);
    const score = reasons.length === 0
      ? round(candidate.predictedSuccess * 0.35 + proofScore * 0.3 + (1 - candidate.uncertaintyScore) * 0.15 + reversibilityScore * 0.1 + blastScore * 0.1)
      : -1_000_000;
    return { id: candidate.id, eligible: reasons.length === 0, reasons, score, planDigest: candidate.planDigest };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.id.localeCompare(b.id));

  const selected = evaluations.find((evaluation) => evaluation.eligible);
  if (!selected) throw new OperatorError('PROOF_AWARE_PLAN_UNAVAILABLE', 'No plan candidate satisfies proof, authority, uncertainty, reversibility and verification obligations.');
  const base = {
    schemaVersion: 1 as const,
    objectiveId: objective.id,
    authorityDigest: objective.authorityDigest,
    selectedPlanId: selected.id,
    selectedPlanDigest: selected.planDigest,
    evaluations
  };
  return { ...base, decisionDigest: hash(base) };
}

export function normalizeAgentTrustEnvelope(input: Omit<CanonicalAgentTrustEnvelope, 'schemaVersion' | 'envelopeDigest'>): CanonicalAgentTrustEnvelope {
  const base = {
    schemaVersion: 1 as const,
    vendor: boundedId(input.vendor, 'vendor'),
    agentStack: boundedId(input.agentStack, 'agentStack'),
    principalId: boundedId(input.principalId, 'principalId'),
    objectiveId: boundedId(input.objectiveId, 'objectiveId'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    planDigest: digest(input.planDigest, 'planDigest'),
    proofBundleDigest: digest(input.proofBundleDigest, 'proofBundleDigest'),
    lineageDigests: digestList(input.lineageDigests, 100_000, 'lineageDigests'),
    evidenceDigests: digestList(input.evidenceDigests, 100_000, 'evidenceDigests'),
    outcome: input.outcome
  };
  if (!['VERIFIED', 'FAILED', 'RECOVERY_REQUIRED'].includes(base.outcome)) throw invalid('Agent outcome is invalid.');
  if (base.lineageDigests.length < 1 || base.evidenceDigests.length < 1) throw invalid('Cross-agent receipt requires lineage and evidence.');
  return { ...base, envelopeDigest: hash(base) };
}

export class ReceiptGatedLearningStore {
  #store: ControlPlaneStore;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
  }

  async learn(input: {
    objectiveId: string;
    strategyKey: string;
    contentDigest: string;
    proofBundle: SignedProofBundle;
    publicKeyPem: string;
    artifactBytes: Record<string, string | Uint8Array>;
    certification: LearningCertificationWitness;
  }): Promise<LearnedEngineeringStrategy> {
    const objectiveId = boundedId(input.objectiveId, 'objectiveId');
    const objectiveRecord = await this.#store.get(NAMESPACE, 'objective:' + objectiveId);
    if (!objectiveRecord) throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Learning objective does not exist.');
    const objective = normalizeEngineeringObjective(objectiveRecord.value);
    if (objective.state !== 'CERTIFIED') throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Only certified objectives may produce reusable learning.');
    if (!objective.proofBundleDigest || objective.proofBundleDigest !== input.proofBundle.digest) {
      throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Proof bundle is not the objective-bound proof receipt.');
    }

    const proof = verifySignedProofBundle(input.proofBundle, {
      publicKeyPem: input.publicKeyPem,
      artifactBytes: input.artifactBytes
    });
    if (!proof.valid) throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Proof bundle failed external verification.', { details: { reasons: proof.reasons } });
    if (input.proofBundle.body.authority.authorityDigest !== objective.authorityDigest) {
      throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Learning proof authority does not match the certified objective.');
    }

    const witness = normalizeWitness(input.certification);
    if (witness.status !== 'CERTIFIED' || witness.authorityViolations !== 0 || witness.learningPolicyViolations !== 0 || !witness.portableProof) {
      throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Certification witness does not permit learning.');
    }
    if (objective.certificationDigest !== witness.certificationDigest) {
      throw new OperatorError('RECEIPT_GATED_LEARNING_DENIED', 'Certification witness is not bound to the objective.');
    }

    const strategyKey = boundedId(input.strategyKey, 'strategyKey');
    const contentDigest = digest(input.contentDigest, 'contentDigest');
    const key = 'skill:' + strategyKey;
    const existing = await this.#store.get(NAMESPACE, key);
    const now = this.#clock().toISOString();
    let value: LearnedEngineeringStrategy;
    if (existing) {
      const current = normalizeLearnedStrategy(existing.value);
      if (current.contentDigest !== contentDigest) {
        throw new OperatorError('RECEIPT_GATED_LEARNING_CONFLICT', 'A strategy key cannot silently change content under existing verified lineage.');
      }
      value = {
        ...current,
        sourceObjectiveIds: [...new Set([...current.sourceObjectiveIds, objectiveId])].sort(),
        proofBundleDigests: [...new Set([...current.proofBundleDigests, input.proofBundle.digest])].sort(),
        certificationDigests: [...new Set([...current.certificationDigests, witness.certificationDigest])].sort(),
        verificationCount: current.verificationCount + 1,
        updatedAt: now
      };
    } else {
      value = {
        schemaVersion: 1,
        strategyKey,
        contentDigest,
        sourceObjectiveIds: [objectiveId],
        proofBundleDigests: [input.proofBundle.digest],
        certificationDigests: [witness.certificationDigest],
        verificationCount: 1,
        updatedAt: now
      };
    }

    await this.#store.transact([{
      namespace: NAMESPACE,
      key,
      expectedGeneration: existing?.generation ?? null,
      value: value as unknown as Record<string, unknown>
    }], now);
    return value;
  }

  async get(strategyKeyInput: string): Promise<LearnedEngineeringStrategy | null> {
    const record = await this.#store.get(NAMESPACE, 'skill:' + boundedId(strategyKeyInput, 'strategyKey'));
    return record ? normalizeLearnedStrategy(record.value) : null;
  }
}

function normalizeCandidate(input: ProofAwarePlanCandidate): ProofAwarePlanCandidate {
  if (!input || typeof input !== 'object') throw invalid('Plan candidate is invalid.');
  const proofLevel = String(input.proofLevel ?? '') as ProofLevel;
  if (!Object.prototype.hasOwnProperty.call(PROOF_RANK, proofLevel)) throw invalid('Plan proof level is invalid.');
  return {
    id: boundedId(input.id, 'candidate.id'),
    planDigest: digest(input.planDigest, 'planDigest'),
    authorityDigest: digest(input.authorityDigest, 'authorityDigest'),
    proofLevel,
    uncertaintyScore: boundedScore(input.uncertaintyScore, 'uncertaintyScore'),
    reversible: input.reversible === true,
    mutating: input.mutating === true,
    verificationObligations: boundedList(input.verificationObligations, 1000, 'verificationObligations'),
    estimatedBlastRadius: boundedInteger(input.estimatedBlastRadius, 0, 1_000_000, 'estimatedBlastRadius'),
    predictedSuccess: boundedScore(input.predictedSuccess, 'predictedSuccess')
  };
}

function normalizeWitness(input: LearningCertificationWitness): LearningCertificationWitness {
  if (!input || !['CERTIFIED', 'NOT_CERTIFIED'].includes(input.status)) throw invalid('Certification witness is invalid.');
  return {
    status: input.status,
    certificationDigest: digest(input.certificationDigest, 'certificationDigest'),
    authorityViolations: boundedInteger(input.authorityViolations, 0, Number.MAX_SAFE_INTEGER, 'authorityViolations'),
    learningPolicyViolations: boundedInteger(input.learningPolicyViolations, 0, Number.MAX_SAFE_INTEGER, 'learningPolicyViolations'),
    portableProof: input.portableProof === true
  };
}

function normalizeLearnedStrategy(input: Record<string, unknown>): LearnedEngineeringStrategy {
  return {
    schemaVersion: 1,
    strategyKey: boundedId(input.strategyKey, 'strategyKey'),
    contentDigest: digest(input.contentDigest, 'contentDigest'),
    sourceObjectiveIds: idList(input.sourceObjectiveIds, 100_000, 'sourceObjectiveIds'),
    proofBundleDigests: digestList(input.proofBundleDigests, 100_000, 'proofBundleDigests'),
    certificationDigests: digestList(input.certificationDigests, 100_000, 'certificationDigests'),
    verificationCount: boundedInteger(input.verificationCount, 1, Number.MAX_SAFE_INTEGER, 'verificationCount'),
    updatedAt: canonicalIso(input.updatedAt, 'updatedAt')
  };
}

function boundedId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(text)) throw invalid(label + ' is invalid.');
  return text;
}
function boundedList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.');
  return [...new Set(value.map((item) => boundedId(item, label)))].sort();
}
function idList(value: unknown, maxItems: number, label: string): string[] { return boundedList(value, maxItems, label); }
function digestList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid(label + ' is invalid.');
  return [...new Set(value.map((item) => digest(item, label)))].sort();
}
function digest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalid(label + ' must be SHA-256.');
  return text;
}
function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(label + ' must be canonical ISO.');
  return text;
}
function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw invalid(label + ' is invalid.');
  return number;
}
function boundedScore(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw invalid(label + ' must be between 0 and 1.');
  return number;
}
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function hash(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function invalid(message: string): OperatorError { return new OperatorError('PROOF_AWARE_AUTONOMY_INVALID', message); }
