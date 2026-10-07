import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ActionRequest, ActionResult, Evidence } from './types.ts';
import type {
  ActionDescriptor as AdaptiveActionDescriptor,
  ActionOutcome as AdaptiveActionOutcome,
  EvidenceRef as AdaptiveEvidenceRef,
  RecoveryKind
} from '../../packages/adaptive-intelligence/src/contracts.ts';
import type {
  ExecutionObservation as VerifiedExecutionObservation
} from '../../packages/verified-plan-runtime/src/contracts.ts';

export type RuntimeAdvisoryCommand =
  | 'OBSERVE'
  | 'REGROUND'
  | 'REPLAN'
  | 'REPAIR'
  | 'RECONCILE'
  | 'WAIT'
  | 'VERIFY'
  | 'FAIL_SAFE'
  | 'ESCALATE';

export function adaptiveRecoveryToAdvisory(kind: RecoveryKind): RuntimeAdvisoryCommand {
  const mapping: Record<RecoveryKind, RuntimeAdvisoryCommand> = {
    REOBSERVE: 'OBSERVE',
    REGROUND: 'REGROUND',
    REPLAN: 'REPLAN',
    REPAIR: 'REPAIR',
    RECONCILE: 'RECONCILE',
    WAIT: 'WAIT',
    VERIFY: 'VERIFY',
    FAIL_SAFE: 'FAIL_SAFE'
  };
  return mapping[kind];
}

export function coreEvidenceToAdaptiveRefs(evidenceInput: Evidence[]): AdaptiveEvidenceRef[] {
  if (!Array.isArray(evidenceInput) || evidenceInput.length > 10_000) throw new Error('evidence collection is invalid.');
  return evidenceInput.map((item) => ({
    digest: crypto.createHash('sha256').update(canonicalJson(item), 'utf8').digest('hex'),
    source: bounded(item.kind, 256, 'evidence.kind'),
    observedAt: canonicalIso(item.timestamp, 'evidence.timestamp'),
    channel: 'runtime-evidence',
    independenceKey: crypto.createHash('sha256')
      .update(canonicalJson({ kind: item.kind, status: item.status, timestamp: item.timestamp }), 'utf8')
      .digest('hex')
  }));
}

export function coreActionToAdaptiveDescriptor(
  action: ActionRequest,
  input: { family?: string; strategyId?: string; expectedEffects?: string[] } = {}
): AdaptiveActionDescriptor {
  return {
    id: bounded(action.id, 256, 'action.id'),
    family: bounded(input.family ?? action.capability.split('.')[0] ?? action.capability, 256, 'action.family'),
    capability: bounded(action.capability, 256, 'action.capability'),
    risk: adaptiveRisk(action.risk),
    ...(action.target ? { semanticTarget: digestText(action.target) } : {}),
    ...(input.strategyId ? { strategyId: bounded(input.strategyId, 256, 'strategyId') } : {}),
    ...(input.expectedEffects ? { expectedEffects: uniqueBounded(input.expectedEffects, 1000, 512, 'expectedEffects') } : {})
  };
}

export function coreResultToAdaptiveOutcome(action: ActionRequest, result: ActionResult): AdaptiveActionOutcome {
  const sideEffectState = result.error?.sideEffectState ?? (action.risk === 'read' ? 'none' : result.ok ? 'known' : 'uncertain');
  return {
    ok: result.ok,
    provider: bounded(result.provider, 256, 'result.provider'),
    durationMs: boundedNumber(result.durationMs, 0, 24 * 60 * 60_000, 'result.durationMs'),
    ...(result.error?.code ? { errorCode: bounded(result.error.code, 256, 'result.error.code') } : {}),
    sideEffectState,
    executionPhase: adaptivePhase(result.error?.executionPhase),
    evidence: coreEvidenceToAdaptiveRefs(result.evidence)
  };
}

export function verifiedObservationFromAuthoritativeOutcome(input: {
  result: ActionResult;
  changedFactKeys?: string[];
  supportedFactKeys?: string[];
  contradictedFactKeys?: string[];
  evidenceDigests?: string[];
}): VerifiedExecutionObservation {
  const sideEffectState = input.result.error?.sideEffectState ?? (input.result.ok ? 'known' : 'uncertain');
  return {
    changedFactKeys: uniqueBounded(input.changedFactKeys ?? [], 10_000, 512, 'changedFactKeys'),
    supportedFactKeys: uniqueBounded(input.supportedFactKeys ?? [], 10_000, 512, 'supportedFactKeys'),
    contradictedFactKeys: uniqueBounded(input.contradictedFactKeys ?? [], 10_000, 512, 'contradictedFactKeys'),
    executionOk: input.result.ok,
    sideEffectState,
    ...(input.evidenceDigests ? { evidenceDigests: uniqueDigests(input.evidenceDigests, 'evidenceDigests') } : {})
  };
}

function adaptiveRisk(risk: ActionRequest['risk']): AdaptiveActionDescriptor['risk'] {
  if (risk === 'read') return 'read';
  if (risk === 'write') return 'write';
  if (risk === 'external') return 'network';
  return 'execute';
}
function adaptivePhase(phase: ActionResult['error'] extends infer _ ? string | undefined : never): AdaptiveActionOutcome['executionPhase'] {
  if (phase === 'pre_dispatch') return 'pre_dispatch';
  if (phase === 'dispatched') return 'dispatching';
  if (phase === 'effect_observed' || phase === 'reconciled') return 'effect_observed';
  return 'unknown';
}
function digestText(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function uniqueDigests(input: string[], label: string): string[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error(`${label} is invalid.`);
  const values = input.map((item) => {
    const value = String(item).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} contains invalid digest.`);
    return value;
  });
  return [...new Set(values)].sort();
}
function uniqueBounded(input: string[], max: number, bytes: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw new Error(`${label} is invalid.`);
  return [...new Set(input.map((item) => bounded(item, bytes, label)))].sort();
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > max || input.includes('\0')) throw new Error(`${label} is invalid.`);
  return input;
}
function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new Error(`${label} is invalid.`);
  return input;
}
function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${label} must be canonical ISO.`);
  return value;
}
