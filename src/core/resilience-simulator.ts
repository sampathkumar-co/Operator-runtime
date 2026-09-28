import type { ResilienceControl, ResilienceScenario } from './resilience-matrix.ts';

export type ResilienceHazard =
  | 'stale-intent' | 'authority-expansion' | 'hypothesis-as-fact' | 'confidence-as-permission'
  | 'context-overexposure' | 'missing-critical-context' | 'canonical-memory-write' | 'context-contamination'
  | 'uncertain-side-effect' | 'duplicate-mutation' | 'unverified-completion' | 'collapsed-separation'
  | 'unbounded-blast-radius' | 'provider-unavailable' | 'provider-drift' | 'lost-durable-state'
  | 'privacy-policy-bypass' | 'learning-poison' | 'learning-authority-escalation' | 'missing-causal-trace'
  | 'budget-overrun' | 'deadline-overrun' | 'concurrent-mutation' | 'stale-lease'
  | 'conversation-fragmentation' | 'internal-chatter-leak' | 'untrusted-provenance' | 'stale-evidence'
  | 'evidence-conflict' | 'capability-mismatch' | 'correlated-reasoning' | 'invalid-graph'
  | 'missing-dependency' | 'graph-cycle' | 'graph-unbounded' | 'rollback-failed'
  | 'tool-corruption' | 'approval-replay' | 'verification-false-positive' | 'correlated-verification';

const FAMILY_HAZARDS: Record<string, readonly ResilienceHazard[]> = {
  F01: ['stale-intent','conversation-fragmentation'],
  F02: ['stale-intent','concurrent-mutation'],
  F03: ['stale-intent','authority-expansion'],
  F04: ['conversation-fragmentation','evidence-conflict'],
  F05: ['authority-expansion','unbounded-blast-radius'],
  F06: ['unverified-completion','collapsed-separation'],
  F07: ['stale-intent','conversation-fragmentation'],
  F08: ['hypothesis-as-fact','untrusted-provenance'],
  F09: ['hypothesis-as-fact','evidence-conflict'],
  F10: ['stale-evidence','hypothesis-as-fact'],
  F11: ['missing-critical-context','unverified-completion'],
  F12: ['context-overexposure','privacy-policy-bypass'],
  F13: ['untrusted-provenance','missing-causal-trace'],
  F14: ['canonical-memory-write','context-contamination'],
  F15: ['hypothesis-as-fact','unverified-completion'],
  F16: ['confidence-as-permission','unverified-completion'],
  F17: ['capability-mismatch','unverified-completion'],
  F18: ['correlated-reasoning','unverified-completion'],
  F19: ['hypothesis-as-fact','correlated-reasoning'],
  F20: ['provider-drift','learning-poison'],
  F21: ['provider-unavailable','lost-durable-state'],
  F22: ['invalid-graph','authority-expansion'],
  F23: ['missing-dependency','concurrent-mutation'],
  F24: ['graph-cycle','budget-overrun'],
  F25: ['graph-unbounded','budget-overrun'],
  F26: ['concurrent-mutation','unbounded-blast-radius'],
  F27: ['stale-lease','authority-expansion'],
  F28: ['duplicate-mutation','missing-causal-trace'],
  F29: ['uncertain-side-effect','duplicate-mutation'],
  F30: ['uncertain-side-effect','rollback-failed'],
  F31: ['tool-corruption','untrusted-provenance'],
  F32: ['authority-expansion','confidence-as-permission'],
  F33: ['approval-replay','missing-causal-trace'],
  F34: ['verification-false-positive','unverified-completion'],
  F35: ['correlated-verification','unverified-completion'],
  F36: ['budget-overrun','graph-unbounded'],
  F37: ['deadline-overrun','graph-unbounded'],
  F38: ['learning-poison','learning-authority-escalation'],
  F39: ['missing-causal-trace','internal-chatter-leak'],
  F40: ['provider-unavailable','lost-durable-state','uncertain-side-effect']
};

const MODIFIER_HAZARDS: Record<string, readonly ResilienceHazard[]> = {
  M01: [],
  M02: ['context-overexposure','budget-overrun'],
  M03: ['stale-intent'],
  M04: ['stale-intent'],
  M05: ['uncertain-side-effect'],
  M06: ['concurrent-mutation','stale-lease'],
  M07: ['concurrent-mutation','missing-causal-trace'],
  M08: ['lost-durable-state','uncertain-side-effect','untrusted-provenance'],
  M09: ['lost-durable-state','duplicate-mutation'],
  M10: ['uncertain-side-effect'],
  M11: ['provider-unavailable','deadline-overrun'],
  M12: ['uncertain-side-effect','tool-corruption'],
  M13: ['duplicate-mutation'],
  M14: ['untrusted-provenance','uncertain-side-effect'],
  M15: ['approval-replay','duplicate-mutation','stale-evidence'],
  M16: ['context-overexposure','budget-overrun'],
  M17: ['missing-critical-context','evidence-conflict'],
  M18: ['evidence-conflict','hypothesis-as-fact'],
  M19: ['stale-evidence'],
  M20: ['privacy-policy-bypass','context-overexposure'],
  M21: ['budget-overrun','capability-mismatch'],
  M22: ['deadline-overrun','capability-mismatch'],
  M23: ['provider-unavailable','privacy-policy-bypass'],
  M24: ['provider-drift','learning-poison'],
  M25: ['confidence-as-permission','verification-false-positive','unbounded-blast-radius','approval-replay']
};

const CONTROL_EFFECTS: Record<ResilienceControl, readonly ResilienceHazard[]> = {
  'intent-versioning': ['stale-intent'],
  'intent-revalidation': ['stale-intent'],
  'worker-cancellation': ['stale-intent','concurrent-mutation'],
  'graph-reconciliation': ['conversation-fragmentation','invalid-graph','missing-dependency','evidence-conflict'],
  'authority-non-expansion': ['authority-expansion','learning-authority-escalation'],
  'policy-fail-closed': ['authority-expansion','confidence-as-permission','privacy-policy-bypass'],
  'context-firewall': ['hypothesis-as-fact','context-contamination','canonical-memory-write'],
  'minimum-context': ['context-overexposure'],
  'provenance-binding': ['untrusted-provenance','missing-causal-trace'],
  'freshness-check': ['stale-evidence'],
  'artifact-gating': ['hypothesis-as-fact','canonical-memory-write','collapsed-separation'],
  'capability-routing': ['capability-mismatch','deadline-overrun'],
  'independent-evidence': ['evidence-conflict','hypothesis-as-fact','correlated-reasoning','missing-critical-context','tool-corruption'],
  'provider-fallback': ['provider-unavailable','deadline-overrun'],
  'provider-quarantine': ['provider-drift','learning-poison'],
  'dag-validation': ['invalid-graph','missing-dependency','graph-cycle'],
  'bounded-decomposition': ['graph-unbounded','graph-cycle','budget-overrun'],
  'resource-leases': ['concurrent-mutation','stale-lease'],
  'revision-cas': ['concurrent-mutation','stale-lease'],
  'idempotency': ['duplicate-mutation'],
  'side-effect-reconciliation': ['uncertain-side-effect','rollback-failed'],
  'compensation': ['rollback-failed'],
  'tool-result-validation': ['tool-corruption'],
  'action-bound-approval': ['approval-replay','authority-expansion'],
  'heterogeneous-verification': ['unverified-completion','verification-false-positive','correlated-verification','correlated-reasoning','collapsed-separation'],
  'hard-budget': ['budget-overrun','graph-unbounded'],
  'deadline-budget': ['deadline-overrun'],
  'learning-quarantine': ['learning-poison','learning-authority-escalation'],
  'audit-causal-chain': ['missing-causal-trace','internal-chatter-leak'],
  'durable-checkpoint': ['lost-durable-state'],
  'data-sovereignty': ['privacy-policy-bypass'],
  'human-escalation': ['conversation-fragmentation','evidence-conflict','rollback-failed','missing-critical-context'],
  'uncertainty-budget': ['evidence-conflict','missing-critical-context','hypothesis-as-fact'],
  'blast-radius': ['unbounded-blast-radius'],
  'safe-read-only-continuation': []
};

export interface ResilienceSimulation {
  scenarioId: string;
  injected: ResilienceHazard[];
  resolved: ResilienceHazard[];
  unresolved: ResilienceHazard[];
  controlCoverage: Partial<Record<ResilienceHazard, ResilienceControl[]>>;
}

export function simulateResilienceScenario(scenario: ResilienceScenario): ResilienceSimulation {
  const injected = [...new Set([
    ...(FAMILY_HAZARDS[scenario.familyId] ?? []),
    ...(MODIFIER_HAZARDS[scenario.modifierId] ?? [])
  ])].sort() as ResilienceHazard[];

  const resolved = new Set<ResilienceHazard>();
  const controlCoverage: Partial<Record<ResilienceHazard, ResilienceControl[]>> = {};

  for (const control of scenario.controls) {
    for (const hazard of CONTROL_EFFECTS[control]) {
      if (!injected.includes(hazard)) continue;
      resolved.add(hazard);
      (controlCoverage[hazard] ??= []).push(control);
    }
  }

  return {
    scenarioId: scenario.id,
    injected,
    resolved: [...resolved].sort(),
    unresolved: injected.filter((hazard) => !resolved.has(hazard)),
    controlCoverage
  };
}
