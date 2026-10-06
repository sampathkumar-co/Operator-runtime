import crypto from 'node:crypto';
import type {
  LearningMode,
  LearningReceipt,
  LearningVerificationReceiptRef,
  SkillDraft
} from './contracts.ts';
import { validateSkillDraft } from './skill-schema.ts';

export interface LearningPromotionInput {
  skill: SkillDraft;
  mode: LearningMode;
  policyVersion: string;
  verificationReceipts: LearningVerificationReceiptRef[];
  allowedSourceRunIds?: string[];
  blockedIdentifiers?: string[];
}

export class LearningFirewall {
  #seenReceipts = new Set<string>();
  #clock: () => Date;

  constructor(options:{clock?:()=>Date}={}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  static fromState(
    replayDigestsInput:string[],
    options:{clock?:()=>Date}={}
  ):LearningFirewall{
    if(!Array.isArray(replayDigestsInput)||replayDigestsInput.length>1_000_000) {
      throw new Error('learning firewall state is invalid.');
    }
    const firewall=new LearningFirewall(options);
    for(const raw of replayDigestsInput){
      const digest=sha256(raw,'learningReplayDigest');
      if(firewall.#seenReceipts.has(digest)) throw new Error('learning firewall state contains duplicate replay digests.');
      firewall.#seenReceipts.add(digest);
    }
    return firewall;
  }

  exportState():string[]{
    return [...this.#seenReceipts].sort();
  }

  evaluate(input: LearningPromotionInput): LearningReceipt {
    const skill = validateSkillDraft(input.skill);
    const policyVersion = bounded(input.policyVersion, 256, 'policyVersion');
    const blocked = unique(input.blockedIdentifiers ?? []).filter(Boolean);

    if (input.mode === 'EVALUATION_FROZEN') {
      return receipt(skill, false, 'Evaluation-frozen mode forbids policy/skill promotion.', policyVersion);
    }
    if (input.mode === 'SHADOW') {
      return receipt(skill, false, 'Shadow mode records recommendations but forbids promotion.', policyVersion);
    }
    if ((skill.benchmarkIdentifiers?.length ?? 0) > 0) {
      return receipt(skill, false, 'Benchmark/evaluation lineage is declared on this skill and cannot be promoted as generic learning.', policyVersion);
    }

    const verificationReceipts = normalizeVerificationReceipts(input.verificationReceipts, this.#clock());
    if (verificationReceipts.length === 0) {
      return receipt(skill, false, 'Authoritative verification receipt references are required before reusable learning.', policyVersion);
    }

    const receiptDigests = unique(verificationReceipts.map((item) => item.digest));
    const receiptRuns = unique(verificationReceipts.map((item) => item.sourceRunId));
    if (!sameSet(receiptDigests, skill.verificationDigests)) {
      return receipt(skill, false, 'Verification receipt digests do not exactly match the skill verification proof set.', policyVersion);
    }
    if (!sameSet(receiptRuns, skill.sourceRunIds)) {
      return receipt(skill, false, 'Verification receipt source runs do not exactly match the skill source-run set.', policyVersion);
    }

    const allowedRuns = input.allowedSourceRunIds?.length ? new Set(input.allowedSourceRunIds) : undefined;
    if (allowedRuns && skill.sourceRunIds.some((id) => !allowedRuns.has(id))) {
      return receipt(skill, false, 'Skill references a source run that is outside the allowed promotion set.', policyVersion);
    }

    const contamination = contaminationMatches(skill, blocked);
    if (contamination.length > 0) {
      return receipt(skill, false, 'Benchmark/evaluation identifier contamination detected: ' + contamination.join(', '), policyVersion);
    }

    const receiptBinding = verificationReceipts
      .map((item) => item.digest + ':' + item.sourceRunId + ':' + item.verifierId + ':' + item.authoritySnapshotDigest)
      .sort()
      .join(',');
    const key = crypto.createHash('sha256').update(
      skill.fingerprint + ':' + policyVersion + ':' + receiptBinding
    ).digest('hex');
    if (this.#seenReceipts.has(key)) {
      return receipt(skill, false, 'Equivalent verified promotion has already been emitted for this policy version.', policyVersion);
    }
    this.#seenReceipts.add(key);
    return receipt(skill, true, 'Verified generic skill is eligible for promotion.', policyVersion);
  }
}

function normalizeVerificationReceipts(
  input: LearningVerificationReceiptRef[],
  now: Date
): LearningVerificationReceiptRef[] {
  if (!Array.isArray(input) || input.length > 10_000) {
    throw new Error('verificationReceipts is invalid.');
  }
  const seen = new Set<string>();
  const normalized = input.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('learning verification receipt is invalid.');
    const verifiedAt = validIso(item.verifiedAt, 'verificationReceipt.verifiedAt');
    if (Date.parse(verifiedAt) > now.getTime()) {
      throw new Error('Learning verification receipt cannot be future-dated.');
    }
    const receipt:LearningVerificationReceiptRef = {
      digest:sha256(item.digest,'verificationReceipt.digest'),
      goalId:bounded(item.goalId,256,'verificationReceipt.goalId'),
      verifierId:bounded(item.verifierId,512,'verificationReceipt.verifierId'),
      verifiedAt,
      authoritySnapshotDigest:sha256(item.authoritySnapshotDigest,'verificationReceipt.authoritySnapshotDigest'),
      sourceRunId:bounded(item.sourceRunId,512,'verificationReceipt.sourceRunId')
    };
    const identity = receipt.digest + ':' + receipt.sourceRunId;
    if (seen.has(identity)) throw new Error('Duplicate learning verification receipt reference.');
    seen.add(identity);
    return receipt;
  });
  return normalized.sort((a,b)=>a.digest.localeCompare(b.digest)||a.sourceRunId.localeCompare(b.sourceRunId));
}

function contaminationMatches(skill: ReturnType<typeof validateSkillDraft>, blockedIdentifiers: string[]): string[] {
  if (blockedIdentifiers.length === 0) return [];
  const haystack = JSON.stringify({
    id: skill.id,
    title: skill.title,
    objectiveKind: skill.objectiveKind,
    scopeClass: skill.scopeClass,
    assumptions: skill.assumptions,
    steps: skill.steps
  }).toLowerCase();
  return blockedIdentifiers
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 3 && haystack.includes(item));
}

function receipt(
  skill: ReturnType<typeof validateSkillDraft>,
  promoted: boolean,
  reason: string,
  policyVersion: string
): LearningReceipt {
  return {
    skillId: skill.id,
    promoted,
    reason,
    verificationDigests: [...skill.verificationDigests],
    policyVersion,
    sourceRunIds: [...skill.sourceRunIds]
  };
}
function sameSet(a:string[],b:string[]):boolean{
  if(a.length!==b.length) return false;
  const expected=new Set(b);
  return a.every((item)=>expected.has(item));
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function sha256(input:unknown,label:string):string{
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input.toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw new Error(label+' must be SHA-256.');
  return value;
}
function validIso(input:unknown,label:string):string{
  if (typeof input !== 'string') throw new Error(label + ' must be a string.');
  const value = input;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) throw new Error(label+' must be ISO timestamp.');
  return value;
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
