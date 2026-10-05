import crypto from 'node:crypto';
import type { LearningMode, LearningReceipt, SkillDraft } from './contracts.ts';
import { validateSkillDraft } from './skill-schema.ts';

export interface LearningPromotionInput {
  skill: SkillDraft;
  mode: LearningMode;
  policyVersion: string;
  independentlyVerified: boolean;
  allowedSourceRunIds?: string[];
  blockedIdentifiers?: string[];
}

export class LearningFirewall {
  #seenReceipts = new Set<string>();

  static fromSnapshot(digestsInput: string[]): LearningFirewall {
    if (!Array.isArray(digestsInput) || digestsInput.length > 1_000_000) throw new Error('learning firewall snapshot is invalid.');
    const firewall = new LearningFirewall();
    for (const digestInput of digestsInput) {
      const digest = sha256(digestInput, 'learningReceiptDigest');
      if (firewall.#seenReceipts.has(digest)) throw new Error('learning firewall snapshot contains duplicate replay digests.');
      firewall.#seenReceipts.add(digest);
    }
    return firewall;
  }

  snapshot(): string[] {
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
    if (!input.independentlyVerified) {
      return receipt(skill, false, 'Independent verification is required before reusable learning.', policyVersion);
    }
    if (skill.verificationDigests.length === 0) {
      return receipt(skill, false, 'At least one independent verification digest is required.', policyVersion);
    }

    const allowedRuns = input.allowedSourceRunIds?.length ? new Set(input.allowedSourceRunIds) : undefined;
    if (allowedRuns && skill.sourceRunIds.some((id) => !allowedRuns.has(id))) {
      return receipt(skill, false, 'Skill references a source run that is outside the allowed promotion set.', policyVersion);
    }

    const contamination = contaminationMatches(skill, blocked);
    if (contamination.length > 0) {
      return receipt(skill, false, 'Benchmark/evaluation identifier contamination detected: ' + contamination.join(', '), policyVersion);
    }

    const key = crypto.createHash('sha256').update(
      skill.fingerprint + ':' + policyVersion + ':' + [...skill.verificationDigests].sort().join(',')
    ).digest('hex');
    if (this.#seenReceipts.has(key)) {
      return receipt(skill, false, 'Equivalent verified promotion has already been emitted for this policy version.', policyVersion);
    }
    this.#seenReceipts.add(key);
    return receipt(skill, true, 'Verified generic skill is eligible for promotion.', policyVersion);
  }
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
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function sha256(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}
