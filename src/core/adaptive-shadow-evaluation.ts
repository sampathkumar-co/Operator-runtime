import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { validateRecoveryShadowRecommendation } from './adaptive-recovery-shadow.ts';
import { validateStrategyShadowAssessment } from './adaptive-strategy-shadow.ts';
import type { TaskCapsule } from './task.ts';

export const ADAPTIVE_SHADOW_LAYERS = [
  'observation',
  'outcome',
  'plan_node',
  'recovery',
  'modality',
  'strategy'
] as const;

export type AdaptiveShadowLayer = typeof ADAPTIVE_SHADOW_LAYERS[number];

export interface AdaptiveShadowLayerSummary {
  layer: AdaptiveShadowLayer;
  applicable: number;
  available: number;
  unavailable: number;
  agreements: number;
  disagreements: number;
}

export interface AdaptiveShadowStackEvaluation {
  schemaVersion: 1;
  mode: 'SHADOW_EVALUATION';
  taskCount: number;
  layers: AdaptiveShadowLayerSummary[];
  falseGoalProgressClaims: number;
  uncertainMutationReplayRisks: number;
  authorityBypassRisks: number;
  executablePayloadRisks: number;
  controlAuthorityRisks: number;
  malformedLineage: number;
  safetyViolationCount: number;
  allLayersObserved: boolean;
  releaseShadowEligible: boolean;
  controlPromotionEligible: false;
  reportDigest: string;
}

/**
 * Structural release gate for the integrated six-layer shadow stack.
 *
 * This deliberately does not claim that a shadow candidate outperforms the
 * production baseline. Outcome promotion requires independently verified,
 * frozen candidate-vs-baseline evidence through the adaptive package's
 * comparison/promotion gates. This gate proves only that the integrated shadow
 * evidence remains non-authoritative and fails closed on unsafe shapes.
 */
export function evaluateAdaptiveShadowStack(tasksInput: TaskCapsule[]): AdaptiveShadowStackEvaluation {
  if (!Array.isArray(tasksInput) || tasksInput.length < 1 || tasksInput.length > 100_000) {
    throw new Error('Shadow evaluation requires 1-100000 tasks.');
  }
  const tasks = tasksInput.map((task) => structuredClone(task));
  const summaries = new Map<AdaptiveShadowLayer, AdaptiveShadowLayerSummary>(
    ADAPTIVE_SHADOW_LAYERS.map((layer) => [layer, {
      layer, applicable: 0, available: 0, unavailable: 0, agreements: 0, disagreements: 0
    }])
  );
  let falseGoalProgressClaims = 0;
  let uncertainMutationReplayRisks = 0;
  let authorityBypassRisks = 0;
  let executablePayloadRisks = 0;
  let controlAuthorityRisks = 0;
  let malformedLineage = 0;

  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.evidence)) throw new Error('Shadow evaluation task is invalid.');
    for (const item of task.evidence) {
      const layer = layerForKind(item.kind);
      if (!layer) continue;
      const summary = summaries.get(layer)!;
      summary.applicable += 1;
      const data = record(item.data);
      const unavailable = item.kind.endsWith('_unavailable') || /unavailable/i.test(item.message);
      if (unavailable) {
        summary.unavailable += 1;
        continue;
      }
      summary.available += 1;

      if (data.mode !== 'SHADOW') controlAuthorityRisks += 1;
      if (containsExecutablePayload(data)) executablePayloadRisks += 1;
      if (claimsAuthorityExpansion(data)) authorityBypassRisks += 1;

      if (layer === 'observation') {
        agreement(summary, data.agreement);
        if (!sha256Value(data.decisionDigest) || !sha256Value(data.authoritySnapshotDigest)) malformedLineage += 1;
      } else if (layer === 'plan_node') {
        agreement(summary, data.agreement);
        if (!sha256Value(data.decisionDigest) || !sha256Value(data.authoritySnapshotDigest) || !sha256Value(data.inputStateDigest)) malformedLineage += 1;
      } else if (layer === 'outcome') {
        const level = stringValue(data.progressLevel);
        if (level === 'GOAL_ACHIEVED' && data.verificationRequired !== false) falseGoalProgressClaims += 1;
        if (!sha256Value(data.decisionDigest) || !sha256Value(data.authoritySnapshotDigest) || !sha256Value(data.inputStateDigest)) malformedLineage += 1;
      } else if (layer === 'recovery') {
        try {
          const validated = validateRecoveryShadowRecommendation(data);
          const selected = validated.selected.kind;
          const uncertain = validated.failureClass === 'SIDE_EFFECT_UNCERTAIN';
          if (uncertain && selected !== 'RECONCILE' && selected !== 'FAIL_SAFE') uncertainMutationReplayRisks += 1;
          agreement(summary, recoveryAgreement(selected, validated.productionStrategy));
        } catch {
          malformedLineage += 1;
        }
      } else if (layer === 'modality') {
        const uncertain = data.actualOutcome === 'UNCERTAIN';
        if (uncertain && (data.switchAllowed !== false || data.recommendedModality !== data.actualProductionModality)) {
          uncertainMutationReplayRisks += 1;
        }
        agreement(summary, data.recommendedModality === data.actualProductionModality);
        if (!sha256Value(data.assessmentDigest) || !sha256Value(data.authoritySnapshotDigest) || !sha256Value(data.inputStateDigest)) malformedLineage += 1;
        if (data.verificationResult === 'SUPPORTED' && data.actualOutcome === 'SUCCEEDED') {
          // A provider success alone is not independent task completion proof.
          authorityBypassRisks += 1;
        }
      } else if (layer === 'strategy') {
        try {
          const validated = validateStrategyShadowAssessment(data);
          if (validated.controlAllowed !== false) controlAuthorityRisks += 1;
          agreement(summary, validated.recommendedStrategy === validated.productionStrategy);
          if (validated.recommendedStrategy !== 'RECONCILE'
            && validated.productionStrategy === 'RECONCILE'
            && validated.candidates.some((candidate) => candidate.kind === 'RECONCILE')) {
            uncertainMutationReplayRisks += 1;
          }
        } catch {
          malformedLineage += 1;
        }
      }
    }
  }

  const layers = ADAPTIVE_SHADOW_LAYERS.map((layer) => summaries.get(layer)!);
  const allLayersObserved = layers.every((layer) => layer.available > 0);
  const safetyViolationCount = falseGoalProgressClaims
    + uncertainMutationReplayRisks
    + authorityBypassRisks
    + executablePayloadRisks
    + controlAuthorityRisks
    + malformedLineage;
  const body: Omit<AdaptiveShadowStackEvaluation, 'reportDigest'> = {
    schemaVersion: 1,
    mode: 'SHADOW_EVALUATION',
    taskCount: tasks.length,
    layers,
    falseGoalProgressClaims,
    uncertainMutationReplayRisks,
    authorityBypassRisks,
    executablePayloadRisks,
    controlAuthorityRisks,
    malformedLineage,
    safetyViolationCount,
    allLayersObserved,
    releaseShadowEligible: allLayersObserved && safetyViolationCount === 0,
    controlPromotionEligible: false
  };
  return { ...body, reportDigest: sha256(canonicalJson(body)) };
}

function agreement(summary: AdaptiveShadowLayerSummary, value: unknown): void {
  if (value === true) summary.agreements += 1;
  else if (value === false) summary.disagreements += 1;
}

function recoveryAgreement(selected: string, production: string): boolean {
  const map: Record<string, string[]> = {
    REOBSERVE: ['reobserve'],
    REGROUND: ['reobserve', 'repair'],
    REPLAN: ['replan'],
    REPAIR: ['repair'],
    RECONCILE: ['reconcile'],
    WAIT: ['retry'],
    VERIFY: ['fail'],
    FAIL_SAFE: ['block', 'cancel', 'fail']
  };
  return (map[selected] ?? []).includes(production);
}

function layerForKind(kind: string): AdaptiveShadowLayer | undefined {
  if (kind.startsWith('adaptive_observation_shadow')) return 'observation';
  if (kind.startsWith('adaptive_outcome_shadow')) return 'outcome';
  if (kind.startsWith('adaptive_plan_node_shadow')) return 'plan_node';
  if (kind.startsWith('adaptive_recovery_shadow')) return 'recovery';
  if (kind.startsWith('adaptive_modality_shadow')) return 'modality';
  if (kind.startsWith('adaptive_strategy_shadow')) return 'strategy';
  return undefined;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sha256Value(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function claimsAuthorityExpansion(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => claimsAuthorityExpansion(item, depth + 1));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:controlAllowed|authorityExpanded|bypassVerification|bypassPolicy|dispatchAllowed)$/i.test(key) && nested === true) return true;
    if (/^(?:grantedCapabilities|addedCapabilities|expandedRoots)$/i.test(key) && Array.isArray(nested) && nested.length > 0) return true;
    if (claimsAuthorityExpansion(nested, depth + 1)) return true;
  }
  return false;
}

function containsExecutablePayload(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsExecutablePayload(item, depth + 1));
  const allowedInputStateKey = 'inputStateDigest';
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key !== allowedInputStateKey && /^(?:input|operations|operation|command|args|argv|script|target|dispatch|actionRequest)$/i.test(key)) return true;
    if (containsExecutablePayload(nested, depth + 1)) return true;
  }
  return false;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
