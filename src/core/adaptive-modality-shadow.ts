import crypto from 'node:crypto';
import { compileExecution, type ExecutionCandidate, type ExecutionModality, type PlanNode } from '../../packages/verified-plan-runtime/src/index.ts';
import { canonicalJson } from './action-identity.ts';
import type { TaskExecutionModality, TaskModalityShadowAdvisor, TaskModalityShadowAssessment } from './task-orchestrator.ts';
import type { ActionRisk } from './types.ts';

const POLICY_VERSION = 'adaptive-modality-shadow-v1';
const FRESHNESS_MS = 5 * 60_000;

/** Fifth activation stage. Compares modality identities after execution and never routes an action. */
export class AdaptiveModalityShadowAdvisor implements TaskModalityShadowAdvisor {
  #now: () => number;
  #platform: NodeJS.Platform;

  constructor(options: { now?: () => number; platform?: NodeJS.Platform } = {}) {
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
  }

  assess(input: Parameters<TaskModalityShadowAdvisor['assess']>[0]): TaskModalityShadowAssessment | undefined {
    if (!input.permissions.allowedCapabilities.includes(input.decision.capability)) return undefined;
    if (!riskWithinPermission(input.risk, input.permissions.maxRisk)) return undefined;
    if (input.productionFailure?.class === 'approval' || input.productionFailure?.class === 'policy') return undefined;

    const actual = modalityFor(input.result.provider, input.decision.capability);
    const fresh = evidenceIsFresh(input.intelligence.retrievedAt, this.#now());
    const candidates = modalityCandidates(input, actual, fresh, this.#platform);
    const node: PlanNode = {
      id: input.actionId, kind: input.risk === 'read' ? 'OBSERVE' : 'ACTION', title: input.decision.title,
      dependsOn: [], preconditions: [], expectedEffects: [], verificationFactKeys: ['independent-result'],
      allowedCapabilities: [input.decision.capability], expectedCost: 1, risk: numericRisk(input.risk),
      reversible: input.risk === 'read' || input.sideEffectState === 'none', maxAttempts: 1
    };
    const available = candidates.filter((candidate) => candidate.available).map(({ available: _available, ...candidate }) => candidate);
    if (available.length === 0) return undefined;
    const ranked = compileExecution(node, available, { maximumRisk: numericRisk(input.permissions.maxRisk ?? 'read') });
    const uncertainMutation = input.risk !== 'read' && input.sideEffectState === 'uncertain';
    const selected = uncertainMutation
      ? ranked.find((candidate) => candidate.modality === actual) ?? ranked[0]!
      : ranked[0]!;
    const rankedByMode = new Map(ranked.map((candidate) => [candidate.modality, candidate]));
    const authoritySnapshotDigest = sha256(canonicalJson({
      allowedCapabilities: [...new Set(input.permissions.allowedCapabilities)].sort(),
      allowedRoots: [...new Set(input.permissions.allowedRoots)].sort(), maxRisk: input.permissions.maxRisk ?? null,
      enterprisePolicyDigest: input.permissions.enterprisePolicyDigest ?? null,
      enterprisePolicyGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      capability: input.decision.capability, risk: input.risk
    }));
    const observationDigest = sha256(canonicalJson({ observation: input.observation, intelligence: fresh ? input.intelligence : { stale: true } }));
    const inputStateDigest = sha256(canonicalJson({
      taskId: input.task.id, actionId: input.actionId, capability: input.decision.capability,
      authoritySnapshotDigest, observationDigest, candidates: candidates.map(candidateIdentity),
      actualProductionModality: actual, uncertainMutation
    }));
    const actualOutcome = input.sideEffectState === 'uncertain' ? 'UNCERTAIN' : input.result.ok ? 'SUCCEEDED' : 'FAILED';
    // This hook runs before planner acceptance and independent task completion verification.
    // A successful provider result is therefore unresolved, never self-certified.
    const verificationResult = input.result.ok ? 'UNRESOLVED' : 'FAILED';
    const body: Omit<TaskModalityShadowAssessment, 'assessmentDigest'> = {
      schemaVersion: 1, mode: 'SHADOW', policyVersion: POLICY_VERSION, taskId: input.task.id,
      actionId: input.actionId, capability: input.decision.capability,
      recommendedModality: selected.modality as TaskExecutionModality, actualProductionModality: actual,
      candidates: candidates.map((candidate) => {
        const rankedCandidate = rankedByMode.get(candidate.modality);
        return {
          modality: candidate.modality as TaskExecutionModality, available: candidate.available,
          predictedSuccess: candidate.expectedSuccess, predictedRisk: numericRisk(input.risk),
          predictedCost: candidate.expectedCost, verificationStrength: candidate.verificationStrength,
          utility: rankedCandidate?.utility ?? null
        };
      }),
      actualOutcome, verificationResult,
      recoveryCost: recoveryCost(input.recoveryRecommendation?.selected.kind),
      latencyMs: Math.max(0, Math.round(input.result.durationMs)),
      failureAttribution: input.outcomeAssessment?.failure?.primaryClass ?? input.productionFailure?.class ?? null,
      switchAllowed: !uncertainMutation,
      authoritySnapshotDigest, observationDigest, inputStateDigest
    };
    return { ...body, assessmentDigest: sha256(canonicalJson(body)) };
  }
}

type CandidateWithAvailability = ExecutionCandidate & { available: boolean };

function modalityCandidates(input: Parameters<TaskModalityShadowAdvisor['assess']>[0], actual: TaskExecutionModality, fresh: boolean, platform: NodeJS.Platform): CandidateWithAvailability[] {
  const modalities = new Map<TaskExecutionModality, boolean>([[actual, true]]);
  const prefix = input.decision.capability.split('.')[0];
  const channels = new Map<string, number>();
  if (fresh) for (const item of input.intelligence.perception) {
    for (const channel of item.channels) channels.set(channel.toLowerCase(), Math.max(channels.get(channel.toLowerCase()) ?? 0, item.confidence));
  }
  const addObserved = (modality: TaskExecutionModality, channel: string) => {
    if (channels.has(channel)) modalities.set(modality, (channels.get(channel) ?? 0) >= 0.5);
  };
  if (prefix === 'browser') {
    modalities.set('PLAYWRIGHT', true);
    addObserved('DOM', 'dom');
    addObserved('ACCESSIBILITY', 'accessibility');
    addObserved('GUI', 'visual');
  } else if (prefix === 'app') {
    modalities.set('APPLICATION', true);
    if (platform === 'win32') {
      if (channels.has('uia')) addObserved('UIA', 'uia');
      else addObserved('UIA', 'accessibility');
    }
    addObserved('GUI', 'visual');
  } else if (['terminal', 'process', 'project'].includes(prefix)) {
    modalities.set('TERMINAL', true);
  } else if (input.risk === 'read' && ['file', 'git', 'docker', 'postgres'].includes(prefix)) {
    modalities.set('OBSERVE', true);
  } else {
    modalities.set('APPLICATION', true);
  }
  return [...modalities.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([modality, available]) => candidate(modality, input.decision.capability, available, input.risk !== 'read'));
}

function candidate(modality: TaskExecutionModality, capability: string, available: boolean, mutating: boolean): CandidateWithAvailability {
  const profile = ({
    DOM: [.86, 1, .1, .9], ACCESSIBILITY: [.8, 1.2, .16, .86], UIA: [.82, 1.3, .14, .88],
    PLAYWRIGHT: [.84, 1.4, .12, .9], APPLICATION: [.8, 1.5, .15, .85], API: [.88, 1, .08, .9],
    MCP: [.82, 1.2, .12, .86], TERMINAL: [.78, 1.4, .18, .82], OBSERVE: [.9, .8, .05, .92], GUI: [.64, 2.5, .35, .62]
  } as const)[modality];
  return {
    id: `modality:${modality.toLowerCase()}`, modality: modality as ExecutionModality, capability,
    expectedSuccess: profile[0], expectedCost: profile[1], uncertainty: profile[2],
    verificationStrength: profile[3], mutating, supportsRollback: !mutating, available
  };
}

function modalityFor(provider: string, capability: string): TaskExecutionModality {
  const value = `${provider} ${capability}`.toLowerCase();
  if (/playwright/.test(value)) return 'PLAYWRIGHT';
  if (/browser|cdp/.test(value)) return 'DOM';
  if (/uia/.test(value)) return 'UIA';
  if (/terminal|process|project\.command/.test(value)) return 'TERMINAL';
  if (/mcp/.test(value)) return 'MCP';
  if (/api|postgres|docker/.test(value)) return 'API';
  if (/inspect|verify|\.read|\.info/.test(capability)) return 'OBSERVE';
  return 'APPLICATION';
}

function evidenceIsFresh(timestamp: string, now: number): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value <= now + 1_000 && now - value <= FRESHNESS_MS;
}

function riskWithinPermission(risk: ActionRisk, maximum: ActionRisk | undefined): boolean {
  return riskRank(risk) <= riskRank(maximum ?? 'read');
}
function riskRank(risk: ActionRisk): number { return ({ read: 0, write: 1, external: 2, system: 3, destructive: 4 })[risk]; }
function numericRisk(risk: ActionRisk): number { return riskRank(risk) / 4; }
function recoveryCost(kind: string | undefined): number { return ({ REOBSERVE: 1, REGROUND: 2, REPLAN: 3, REPAIR: 2, RECONCILE: 2, WAIT: 1, VERIFY: 1, FAIL_SAFE: 0 } as Record<string, number>)[kind ?? ''] ?? 0; }
function candidateIdentity(candidate: CandidateWithAvailability) { return { modality: candidate.modality, capability: candidate.capability, available: candidate.available }; }
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
