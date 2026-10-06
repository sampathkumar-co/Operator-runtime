import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { RuntimeAdvisoryCommand } from './intelligence-adapters.ts';
import type { ActionRisk } from './types.ts';

export type AdaptivePlanningControlMode =
  | 'SHADOW'
  | 'ADVISORY'
  | 'REVERSIBLE_CANARY'
  | 'GENERAL';

export interface AdaptivePlanningPromotionEvidence {
  representativeShadowDecisions: number;
  representativeTaskCount: number;
  benchmarkExcluded: boolean;
  verifiedOutcomeDelta: number;
  falseCompletionDelta: number;
  repeatedFailureDelta: number;
  recoverySuccessDelta: number;
  authorityExpansionCount: number;
  unsafeReplayCount: number;
  statisticallyDefensible: boolean;
  deterministicRestartVerified: boolean;
  rollbackSnapshotDigest: string;
  verificationReceiptDigests: string[];
  evaluatedAt: string;
}

export interface AdaptivePlanningControlState {
  schemaVersion: 1;
  mode: AdaptivePlanningControlMode;
  revision: number;
  promotionEvidence?: AdaptivePlanningPromotionEvidence;
  priorModes: AdaptivePlanningControlMode[];
  updatedAt: string;
}

export interface AdaptivePlanningProposalEnvelope {
  proposalDigest: string;
  risk: ActionRisk;
  reversible: boolean;
  checkpointDigest?: string;
  rollbackDigest?: string;
  authorityDigest?: string;
  resourceRevision?: string;
  fenceToken?: string;
  independentVerificationRequired: boolean;
  explicitUserOrPolicyAuthority: boolean;
  freshAuthorityReceiptDigest?: string;
}

export interface AdaptivePlanningInfluenceDecision {
  command: RuntimeAdvisoryCommand;
  mode: AdaptivePlanningControlMode;
  effect: 'SHADOW_ONLY' | 'ADVISORY_ONLY' | 'CONTROL_ALLOWED' | 'CONTROL_BLOCKED';
  reason: string;
  proposalDigest?: string;
  grantsAuthority: false;
  runtimeVetoRequired: true;
}

const MODE_ORDER: AdaptivePlanningControlMode[] = ['SHADOW', 'ADVISORY', 'REVERSIBLE_CANARY', 'GENERAL'];
const SAFETY_ONLY = new Set<RuntimeAdvisoryCommand>(['FAIL_SAFE', 'ESCALATE', 'RECONCILE', 'WAIT', 'VERIFY']);
const CONTROL_COMMANDS = new Set<RuntimeAdvisoryCommand>([
  'OBSERVE', 'REGROUND', 'REPLAN', 'REPAIR', 'RECONCILE', 'WAIT', 'VERIFY', 'FAIL_SAFE', 'ESCALATE'
]);

export class AdaptivePlanningControl {
  #state: AdaptivePlanningControlState;

  constructor(state?: AdaptivePlanningControlState) {
    this.#state = state ? normalizeState(state) : {
      schemaVersion: 1,
      mode: 'SHADOW',
      revision: 1,
      priorModes: [],
      updatedAt: new Date(0).toISOString()
    };
  }

  static fromState(state: AdaptivePlanningControlState): AdaptivePlanningControl {
    return new AdaptivePlanningControl(state);
  }

  state(): AdaptivePlanningControlState {
    return structuredClone(this.#state);
  }

  stateDigest(): string {
    return crypto.createHash('sha256').update(canonicalJson(this.#state), 'utf8').digest('hex');
  }

  promote(
    nextMode: Exclude<AdaptivePlanningControlMode, 'SHADOW'>,
    evidenceInput: AdaptivePlanningPromotionEvidence,
    now = new Date().toISOString()
  ): AdaptivePlanningControlState {
    validIso(now, 'now');
    const evidence = normalizePromotionEvidence(evidenceInput);
    const currentIndex = MODE_ORDER.indexOf(this.#state.mode);
    const nextIndex = MODE_ORDER.indexOf(nextMode);
    if (nextIndex !== currentIndex + 1) {
      throw new Error('Adaptive planning promotion must advance exactly one maturity mode at a time.');
    }
    assertPromotionEligible(nextMode, evidence);
    this.#state = {
      schemaVersion: 1,
      mode: nextMode,
      revision: this.#state.revision + 1,
      promotionEvidence: evidence,
      priorModes: [...this.#state.priorModes, this.#state.mode].slice(-16),
      updatedAt: now
    };
    return this.state();
  }

  rollback(
    targetMode: AdaptivePlanningControlMode,
    rollbackReceiptDigest: string,
    now = new Date().toISOString()
  ): AdaptivePlanningControlState {
    validIso(now, 'now');
    sha256(rollbackReceiptDigest, 'rollbackReceiptDigest');
    const currentIndex = MODE_ORDER.indexOf(this.#state.mode);
    const targetIndex = MODE_ORDER.indexOf(targetMode);
    if (targetIndex < 0 || targetIndex >= currentIndex) throw new Error('Rollback target must be less permissive than current mode.');
    this.#state = {
      schemaVersion: 1,
      mode: targetMode,
      revision: this.#state.revision + 1,
      priorModes: [...this.#state.priorModes, this.#state.mode].slice(-16),
      updatedAt: now
    };
    return this.state();
  }

  assessInfluence(
    command: RuntimeAdvisoryCommand,
    proposalInput?: AdaptivePlanningProposalEnvelope
  ): AdaptivePlanningInfluenceDecision {
    if (!CONTROL_COMMANDS.has(command)) throw new Error('Unsupported adaptive planning command.');
    const base = {
      command,
      mode: this.#state.mode,
      grantsAuthority: false as const,
      runtimeVetoRequired: true as const
    };

    if (this.#state.mode === 'SHADOW') {
      return { ...base, effect: 'SHADOW_ONLY', reason: 'shadow-mode-never-influences-authoritative-control' };
    }
    if (this.#state.mode === 'ADVISORY') {
      return {
        ...base,
        effect: 'ADVISORY_ONLY',
        reason: SAFETY_ONLY.has(command)
          ? 'advisory-safety-recommendation-requires-authoritative-runtime-decision'
          : 'advisory-mode-cannot-change-action-order'
      };
    }

    const proposal = normalizeProposal(proposalInput);
    if (!proposal) {
      return { ...base, effect: 'CONTROL_BLOCKED', reason: 'control-mode-requires-exact-proposal-envelope' };
    }
    const proposalDigest = proposal.proposalDigest;

    if (this.#state.mode === 'REVERSIBLE_CANARY') {
      const lowRisk = proposal.risk === 'read' || proposal.risk === 'write';
      const reversibleEnvelope = proposal.reversible &&
        Boolean(proposal.checkpointDigest) &&
        Boolean(proposal.rollbackDigest) &&
        Boolean(proposal.authorityDigest) &&
        Boolean(proposal.resourceRevision) &&
        Boolean(proposal.fenceToken) &&
        proposal.independentVerificationRequired;
      if (!lowRisk || !reversibleEnvelope) {
        return { ...base, proposalDigest, effect: 'CONTROL_BLOCKED', reason: 'canary-requires-low-risk-reversible-authority-bound-proposal' };
      }
      if (command === 'ESCALATE' || command === 'FAIL_SAFE' || command === 'RECONCILE' || command === 'WAIT' ||
          command === 'VERIFY' || command === 'OBSERVE' || command === 'REGROUND' || command === 'REPLAN' || command === 'REPAIR') {
        return { ...base, proposalDigest, effect: 'CONTROL_ALLOWED', reason: 'reversible-canary-control-with-runtime-veto' };
      }
    }

    const highRisk = proposal.risk === 'external' || proposal.risk === 'system' || proposal.risk === 'destructive' || !proposal.reversible;
    const commonBound = Boolean(proposal.authorityDigest) &&
      Boolean(proposal.resourceRevision) &&
      Boolean(proposal.fenceToken) &&
      proposal.independentVerificationRequired;
    if (!commonBound) {
      return { ...base, proposalDigest, effect: 'CONTROL_BLOCKED', reason: 'general-control-requires-exact-authority-resource-and-verification-binding' };
    }
    if (highRisk && (!proposal.explicitUserOrPolicyAuthority || !proposal.freshAuthorityReceiptDigest)) {
      return { ...base, proposalDigest, effect: 'CONTROL_BLOCKED', reason: 'high-risk-or-irreversible-control-requires-fresh-explicit-authority-receipt' };
    }
    return { ...base, proposalDigest, effect: 'CONTROL_ALLOWED', reason: 'general-bounded-control-with-authoritative-runtime-veto' };
  }
}

export function assertPromotionEligible(
  mode: Exclude<AdaptivePlanningControlMode, 'SHADOW'>,
  evidenceInput: AdaptivePlanningPromotionEvidence
): void {
  const evidence = normalizePromotionEvidence(evidenceInput);
  if (!evidence.benchmarkExcluded) throw new Error('Benchmark-contaminated evidence cannot promote adaptive planning.');
  if (evidence.authorityExpansionCount !== 0) throw new Error('Adaptive planning promotion requires zero authority expansion.');
  if (evidence.unsafeReplayCount !== 0) throw new Error('Adaptive planning promotion requires zero unsafe replay.');
  if (!evidence.deterministicRestartVerified) throw new Error('Adaptive planning promotion requires deterministic restart proof.');
  if (evidence.verificationReceiptDigests.length < 1) throw new Error('Adaptive planning promotion requires independent verification receipts.');

  const minimum = mode === 'ADVISORY'
    ? { decisions: 500, tasks: 100, improvement: 0 }
    : mode === 'REVERSIBLE_CANARY'
      ? { decisions: 2_500, tasks: 250, improvement: Number.EPSILON }
      : { decisions: 10_000, tasks: 1_000, improvement: Number.EPSILON };
  if (evidence.representativeShadowDecisions < minimum.decisions) throw new Error(`${mode} promotion requires more representative shadow decisions.`);
  if (evidence.representativeTaskCount < minimum.tasks) throw new Error(`${mode} promotion requires more representative non-benchmark tasks.`);
  if (evidence.verifiedOutcomeDelta < minimum.improvement) throw new Error(`${mode} promotion requires defensible verified-outcome improvement.`);
  if (mode === 'GENERAL' && !evidence.statisticallyDefensible) throw new Error('GENERAL promotion requires statistically defensible evidence.');
  if (evidence.falseCompletionDelta > 0) throw new Error('Adaptive planning may not increase false completion.');
  if (evidence.repeatedFailureDelta > 0) throw new Error('Adaptive planning may not increase repeated equivalent failure.');
  if (evidence.recoverySuccessDelta < 0) throw new Error('Adaptive planning may not reduce recovery success.');
}

function normalizeState(input: AdaptivePlanningControlState): AdaptivePlanningControlState {
  if (!input || input.schemaVersion !== 1 || !MODE_ORDER.includes(input.mode)) throw new Error('Adaptive planning control state is invalid.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('Adaptive planning control revision is invalid.');
  validIso(input.updatedAt, 'updatedAt');
  if (!Array.isArray(input.priorModes) || input.priorModes.length > 16 || input.priorModes.some((mode) => !MODE_ORDER.includes(mode))) {
    throw new Error('Adaptive planning prior mode history is invalid.');
  }
  return {
    schemaVersion: 1,
    mode: input.mode,
    revision: input.revision,
    ...(input.promotionEvidence ? { promotionEvidence: normalizePromotionEvidence(input.promotionEvidence) } : {}),
    priorModes: [...input.priorModes],
    updatedAt: input.updatedAt
  };
}

function normalizePromotionEvidence(input: AdaptivePlanningPromotionEvidence): AdaptivePlanningPromotionEvidence {
  if (!input || typeof input !== 'object') throw new Error('Adaptive planning promotion evidence is required.');
  validIso(input.evaluatedAt, 'evaluatedAt');
  const verificationReceiptDigests = uniqueDigests(input.verificationReceiptDigests, 'verificationReceiptDigests');
  return {
    representativeShadowDecisions: integer(input.representativeShadowDecisions, 0, 10_000_000, 'representativeShadowDecisions'),
    representativeTaskCount: integer(input.representativeTaskCount, 0, 1_000_000, 'representativeTaskCount'),
    benchmarkExcluded: input.benchmarkExcluded === true,
    verifiedOutcomeDelta: finite(input.verifiedOutcomeDelta, 'verifiedOutcomeDelta'),
    falseCompletionDelta: finite(input.falseCompletionDelta, 'falseCompletionDelta'),
    repeatedFailureDelta: finite(input.repeatedFailureDelta, 'repeatedFailureDelta'),
    recoverySuccessDelta: finite(input.recoverySuccessDelta, 'recoverySuccessDelta'),
    authorityExpansionCount: integer(input.authorityExpansionCount, 0, 1_000_000, 'authorityExpansionCount'),
    unsafeReplayCount: integer(input.unsafeReplayCount, 0, 1_000_000, 'unsafeReplayCount'),
    statisticallyDefensible: input.statisticallyDefensible === true,
    deterministicRestartVerified: input.deterministicRestartVerified === true,
    rollbackSnapshotDigest: sha256(input.rollbackSnapshotDigest, 'rollbackSnapshotDigest'),
    verificationReceiptDigests,
    evaluatedAt: input.evaluatedAt
  };
}

function normalizeProposal(input?: AdaptivePlanningProposalEnvelope): AdaptivePlanningProposalEnvelope | undefined {
  if (!input) return undefined;
  return {
    proposalDigest: sha256(input.proposalDigest, 'proposalDigest'),
    risk: risk(input.risk),
    reversible: input.reversible === true,
    ...(input.checkpointDigest ? { checkpointDigest: sha256(input.checkpointDigest, 'checkpointDigest') } : {}),
    ...(input.rollbackDigest ? { rollbackDigest: sha256(input.rollbackDigest, 'rollbackDigest') } : {}),
    ...(input.authorityDigest ? { authorityDigest: sha256(input.authorityDigest, 'authorityDigest') } : {}),
    ...(input.resourceRevision ? { resourceRevision: boundedId(input.resourceRevision, 'resourceRevision') } : {}),
    ...(input.fenceToken ? { fenceToken: boundedId(input.fenceToken, 'fenceToken') } : {}),
    independentVerificationRequired: input.independentVerificationRequired === true,
    explicitUserOrPolicyAuthority: input.explicitUserOrPolicyAuthority === true,
    ...(input.freshAuthorityReceiptDigest ? { freshAuthorityReceiptDigest: sha256(input.freshAuthorityReceiptDigest, 'freshAuthorityReceiptDigest') } : {})
  };
}

function risk(input: unknown): ActionRisk {
  if (input === 'read' || input === 'write' || input === 'external' || input === 'system' || input === 'destructive') return input;
  throw new Error('Adaptive planning proposal risk is invalid.');
}
function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) throw new Error(label + ' is invalid.');
  return input;
}
function finite(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) throw new Error(label + ' is invalid.');
  return input;
}
function validIso(input: unknown, label: string): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new Error(label + ' must be canonical ISO.');
  return input;
}
function sha256(input: unknown, label: string): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/i.test(input)) throw new Error(label + ' must be SHA-256.');
  return input.toLowerCase();
}
function uniqueDigests(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 100_000) throw new Error(label + ' is invalid.');
  return [...new Set(input.map((value) => sha256(value, label)))].sort();
}
function boundedId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(input)) throw new Error(label + ' is invalid.');
  return input;
}
