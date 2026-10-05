import crypto from 'node:crypto';
import type { SkillDraft, SkillStep } from './contracts.ts';

export interface ValidatedSkillDraft extends SkillDraft {
  fingerprint: string;
}

export function validateSkillDraft(input: SkillDraft): ValidatedSkillDraft {
  if (!input || typeof input !== 'object') throw new Error('skill draft is required.');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 200) {
    throw new Error('skill steps must contain 1-200 entries.');
  }
  const steps = input.steps.map((step, index) => validateStep(step, index));
  const verificationDigests = unique(input.verificationDigests.map((item) => sha256(item, 'verificationDigest')));
  if (verificationDigests.length === 0) throw new Error('skill requires at least one verification digest.');
  const sourceRunIds = unique(input.sourceRunIds.map((item) => bounded(item, 512, 'sourceRunId')));
  if (sourceRunIds.length === 0) throw new Error('skill requires at least one source run.');

  const normalized: SkillDraft = {
    id: bounded(input.id, 256, 'skill.id'),
    objectiveKind: bounded(input.objectiveKind, 256, 'skill.objectiveKind'),
    title: bounded(input.title, 1024, 'skill.title'),
    scopeClass: bounded(input.scopeClass, 512, 'skill.scopeClass'),
    assumptions: unique(input.assumptions.map((item) => bounded(item, 1024, 'skill.assumption'))),
    steps,
    verificationDigests,
    sourceRunIds,
    ...(input.benchmarkIdentifiers?.length
      ? { benchmarkIdentifiers: unique(input.benchmarkIdentifiers.map((item) => bounded(item, 512, 'benchmarkIdentifier'))) }
      : {})
  };

  return {
    ...normalized,
    fingerprint: skillFingerprint(normalized)
  };
}

export function skillFingerprint(skill: SkillDraft): string {
  const canonical = JSON.stringify({
    objectiveKind: skill.objectiveKind,
    scopeClass: skill.scopeClass,
    assumptions: [...skill.assumptions].sort(),
    steps: skill.steps.map((step) => ({
      actionFamily: step.actionFamily,
      capability: step.capability,
      preconditions: [...step.preconditions].sort(),
      expectedEffects: [...step.expectedEffects].sort(),
      verificationFacts: [...step.verificationFacts].sort(),
      recoveryFamilies: [...(step.recoveryFamilies ?? [])].sort()
    }))
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function validateStep(input: SkillStep, index: number): SkillStep {
  if (!input || typeof input !== 'object') throw new Error('skill step ' + index + ' is invalid.');
  return {
    actionFamily: bounded(input.actionFamily, 256, 'skill.step.actionFamily'),
    capability: bounded(input.capability, 256, 'skill.step.capability'),
    preconditions: unique(input.preconditions.map((item) => bounded(item, 512, 'skill.step.precondition'))),
    expectedEffects: unique(input.expectedEffects.map((item) => bounded(item, 512, 'skill.step.expectedEffect'))),
    verificationFacts: unique(input.verificationFacts.map((item) => bounded(item, 512, 'skill.step.verificationFact'))),
    ...(input.recoveryFamilies?.length
      ? { recoveryFamilies: unique(input.recoveryFamilies.map((item) => bounded(item, 256, 'skill.step.recoveryFamily'))) }
      : {})
  };
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function sha256(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}
function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
