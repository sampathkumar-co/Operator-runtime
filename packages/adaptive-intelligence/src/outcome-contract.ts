import type { BeliefResolution, EvidenceRef, EpistemicStatus } from './contracts.ts';

export interface OutcomeFactRequirement {
  factKey: string;
  expectedValueDigest?: string;
  acceptedStatuses?: EpistemicStatus[];
  minConfidence?: number;
  maxEvidenceAgeMs?: number;
  minIndependentSources?: number;
}

export interface OutcomeContract {
  id: string;
  required: OutcomeFactRequirement[];
  forbidden?: OutcomeFactRequirement[];
}

export interface OutcomeContractCheck {
  kind: 'required' | 'forbidden';
  factKey: string;
  ok: boolean;
  reason: string;
  evidenceDigests: string[];
}

export interface OutcomeContractAssessment {
  contractId: string;
  ok: boolean;
  checks: OutcomeContractCheck[];
  evidenceDigests: string[];
  unresolvedFacts: string[];
  failedFacts: string[];
}

/**
 * Deterministic evidence sufficiency check for a generic outcome contract.
 *
 * This is intentionally NOT a replacement for Mecord's VerificationKernel.
 * A future adapter may feed this assessment into the authoritative verifier,
 * but this module never signs/certifies completion itself.
 */
export function assessOutcomeContract(
  contractInput: OutcomeContract,
  beliefs: BeliefResolution[],
  options: { now?: Date } = {}
): OutcomeContractAssessment {
  const contract = normalizeContract(contractInput);
  const byFact = new Map(beliefs.map((belief) => [belief.factKey, belief]));
  const now = options.now ?? new Date();
  const checks: OutcomeContractCheck[] = [];

  for (const requirement of contract.required) {
    checks.push(checkRequirement('required', requirement, byFact.get(requirement.factKey), now));
  }
  for (const requirement of contract.forbidden ?? []) {
    const present = checkRequirement('forbidden', requirement, byFact.get(requirement.factKey), now);
    checks.push({
      ...present,
      ok: !present.ok,
      reason: present.ok
        ? 'Forbidden fact is supported by sufficient current evidence.'
        : 'Forbidden fact is absent, stale, weak, or value-mismatched.'
    });
  }

  const unresolvedFacts = checks
    .filter((check) => !check.ok && check.kind === 'required')
    .map((check) => check.factKey);
  const failedFacts = checks
    .filter((check) => !check.ok)
    .map((check) => check.factKey);

  return {
    contractId: contract.id,
    ok: checks.every((check) => check.ok),
    checks,
    evidenceDigests: [...new Set(checks.flatMap((check) => check.evidenceDigests))].sort(),
    unresolvedFacts: [...new Set(unresolvedFacts)].sort(),
    failedFacts: [...new Set(failedFacts)].sort()
  };
}

function checkRequirement(
  kind: 'required' | 'forbidden',
  requirement: Required<Pick<OutcomeFactRequirement, 'factKey'>> & Omit<OutcomeFactRequirement, 'factKey'>,
  belief: BeliefResolution | undefined,
  now: Date
): OutcomeContractCheck {
  if (!belief) return fail(kind, requirement.factKey, 'No belief exists for required fact.', []);
  const accepted = new Set(requirement.acceptedStatuses ?? ['KNOWN','SUPPORTED']);
  if (!accepted.has(belief.status)) {
    return fail(kind, requirement.factKey, 'Epistemic status ' + belief.status + ' is not accepted.', allEvidence(belief));
  }
  const minConfidence = requirement.minConfidence ?? 0.7;
  if (belief.confidence < minConfidence) {
    return fail(kind, requirement.factKey, 'Confidence is below contract threshold.', allEvidence(belief));
  }
  if (requirement.expectedValueDigest && belief.selectedValueDigest !== requirement.expectedValueDigest) {
    return fail(kind, requirement.factKey, 'Resolved value digest does not match the contract.', allEvidence(belief));
  }

  const evidence = allEvidence(belief);
  if (requirement.maxEvidenceAgeMs !== undefined) {
    const fresh = evidence.filter((item) => now.getTime() - Date.parse(item.observedAt) <= requirement.maxEvidenceAgeMs!);
    if (fresh.length === 0) {
      return fail(kind, requirement.factKey, 'No evidence is fresh enough for the contract.', evidence);
    }
  }
  if (requirement.minIndependentSources !== undefined) {
    const sources = new Set(evidence.map((item) => item.source));
    if (sources.size < requirement.minIndependentSources) {
      return fail(kind, requirement.factKey, 'Independent evidence source count is below the contract threshold.', evidence);
    }
  }

  return {
    kind,
    factKey: requirement.factKey,
    ok: true,
    reason: 'Fact satisfies status, confidence, value, freshness, and independence requirements.',
    evidenceDigests: evidence.map((item) => item.digest).sort()
  };
}

function normalizeContract(input: OutcomeContract): OutcomeContract {
  if (!input || typeof input !== 'object') throw new Error('outcome contract is required.');
  if (!Array.isArray(input.required) || input.required.length < 1 || input.required.length > 1000) {
    throw new Error('outcome contract requires 1-1000 required facts.');
  }
  if (input.forbidden && (!Array.isArray(input.forbidden) || input.forbidden.length > 1000)) {
    throw new Error('outcome contract forbidden facts are invalid.');
  }
  return {
    id: bounded(input.id, 256, 'contract.id'),
    required: input.required.map(normalizeRequirement),
    ...(input.forbidden ? { forbidden: input.forbidden.map(normalizeRequirement) } : {})
  };
}

function normalizeRequirement(input: OutcomeFactRequirement): OutcomeFactRequirement {
  if (!input || typeof input !== 'object') throw new Error('outcome fact requirement is required.');
  const accepted = input.acceptedStatuses ?? ['KNOWN','SUPPORTED'];
  const allowed: EpistemicStatus[] = ['KNOWN','SUPPORTED','CONFLICTED','STALE','UNKNOWN','UNOBSERVABLE','DISPROVEN'];
  if (!Array.isArray(accepted) || accepted.length < 1 || accepted.some((item) => !allowed.includes(item))) {
    throw new Error('acceptedStatuses is invalid.');
  }
  return {
    factKey: bounded(input.factKey, 512, 'factKey'),
    ...(input.expectedValueDigest ? { expectedValueDigest: sha256(input.expectedValueDigest, 'expectedValueDigest') } : {}),
    acceptedStatuses: [...new Set(accepted)],
    ...(input.minConfidence !== undefined ? { minConfidence: unit(input.minConfidence, 'minConfidence') } : {}),
    ...(input.maxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: integer(input.maxEvidenceAgeMs, 0, Number.MAX_SAFE_INTEGER, 'maxEvidenceAgeMs') } : {}),
    ...(input.minIndependentSources !== undefined ? { minIndependentSources: integer(input.minIndependentSources, 1, 1000, 'minIndependentSources') } : {})
  };
}

function allEvidence(belief: BeliefResolution): EvidenceRef[] {
  return [...new Map(
    [...belief.supportingEvidence, ...belief.contradictingEvidence, ...belief.staleEvidence]
      .map((item) => [item.digest, item])
  ).values()];
}
function fail(kind: 'required' | 'forbidden', factKey: string, reason: string, evidence: EvidenceRef[]): OutcomeContractCheck {
  return { kind, factKey, ok: false, reason, evidenceDigests: evidence.map((item) => item.digest).sort() };
}
function bounded(input: unknown, max: number, label: string): string {
  const value=String(input??'');
  if(!value||value.length>max) throw new Error(label+' is invalid.');
  return value;
}
function sha256(input: unknown, label: string): string {
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function unit(input: unknown, label: string): number {
  const value=Number(input);
  if(!Number.isFinite(value)||value<0||value>1) throw new Error(label+' must be between 0 and 1.');
  return value;
}
function integer(input: unknown, min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
