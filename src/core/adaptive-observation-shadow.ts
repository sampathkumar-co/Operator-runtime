import crypto from 'node:crypto';
import { selectObservation, type BeliefResolution, type ObservationCandidate } from '../../packages/adaptive-intelligence/src/index.ts';
import { DecisionTraceLog } from '../../packages/adaptive-intelligence/src/decision-trace.ts';
import { canonicalJson } from './action-identity.ts';
import { capabilityRiskRule } from './capability-policy.ts';
import type {
  SemanticTaskGoal,
  TaskObservationShadowAdvisor,
  TaskObservationShadowRecommendation
} from './task-orchestrator.ts';

const POLICY_VERSION = 'adaptive-observation-shadow-v1';

/** First progressive activation stage. Produces evidence only and never returns an executable action. */
export class AdaptiveObservationShadowAdvisor implements TaskObservationShadowAdvisor {
  #clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  recommend(input: Parameters<TaskObservationShadowAdvisor['recommend']>[0]): TaskObservationShadowRecommendation | undefined {
    if (input.risk !== 'read') return undefined;
    const allowed = new Set(input.permissions.allowedCapabilities);
    const candidates = observationCandidates(input.goal, input.decision.capability, allowed, Boolean(input.intelligence.sceneKey));
    if (candidates.length === 0) return undefined;
    const beliefs = observationBeliefs(input.goal, input.intelligence, this.#clock());
    const selection = selectObservation(beliefs, candidates, {
      remainingCostBudget: Math.max(1, input.intelligence.perception.length + input.intelligence.world.length + 1)
    });
    const authoritySnapshotDigest = sha256(canonicalJson({
      allowedCapabilities: [...allowed].sort(),
      allowedRoots: [...input.permissions.allowedRoots].sort(),
      maxRisk: input.permissions.maxRisk ?? null,
      allowExternalWrites: input.permissions.allowExternalWrites === true,
      allowSystemChanges: input.permissions.allowSystemChanges === true,
      allowDestructive: input.permissions.allowDestructive === true,
      enterprisePolicyDigest: input.permissions.enterprisePolicyDigest ?? null,
      enterprisePolicyGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      intent: input.task.intent ?? null
    }));
    const inputStateDigest = sha256(canonicalJson({
      taskId: input.task.id,
      actionId: input.actionId,
      goalKind: input.goal.kind,
      controlId: input.decision.capability,
      candidates: candidates.map((candidate) => candidate.id),
      beliefs: beliefs.map((belief) => ({ factKey: belief.factKey, status: belief.status, confidence: belief.confidence })),
      retrievedAt: input.intelligence.retrievedAt
    }));
    const trace = new DecisionTraceLog({ maxRecords: 1, clock: this.#clock }).append({
      mode: 'SHADOW', kind: 'OBSERVATION', runId: input.task.id, taskId: input.task.id,
      goalId: input.goal.kind, policyVersion: POLICY_VERSION, decisionPointId: input.actionId,
      selectedId: selection.selected.id, alternatives: selection.ranked.map((candidate) => candidate.id),
      reason: 'Read-only observation ranking executed in shadow mode; the production planner choice remains authoritative.',
      evidence: evidenceRefs(input.intelligence), authoritySnapshotDigest, inputStateDigest
    });
    return {
      mode: 'SHADOW', policyVersion: POLICY_VERSION,
      selectedId: selection.selected.id,
      controlId: input.decision.capability,
      alternatives: selection.ranked.map((candidate) => candidate.id),
      agreement: selection.selected.id === input.decision.capability,
      decisionDigest: trace.decisionDigest,
      authoritySnapshotDigest
    };
  }
}

function observationCandidates(
  goal: SemanticTaskGoal,
  controlCapability: string,
  allowed: Set<string>,
  targetLocal: boolean
): ObservationCandidate[] {
  const byKind: Partial<Record<SemanticTaskGoal['kind'], Array<[string, ObservationCandidate['channel'], number, number]>>> = {
    'controlled-file-change': [['file.info', 'runtime', 0.75, 1], ['file.read', 'runtime', 0.8, 2]],
    'trusted-project-command': [['project.inspect', 'runtime', 0.75, 1], ['git.status', 'runtime', 0.72, 1], ['git.diff', 'runtime', 0.82, 2]],
    'project-quality-gate': [['project.inspect', 'runtime', 0.75, 1], ['git.status', 'runtime', 0.72, 1], ['git.diff', 'runtime', 0.82, 2]],
    'browser-navigation': [['browser.inspect', 'dom', 0.9, 1], ['browser.verify', 'dom', 0.84, 1]],
    'docker-lifecycle': [['docker.inspect', 'runtime', 0.82, 1]],
    'postgres-select': [['postgres.inspect', 'runtime', 0.78, 1], ['postgres.select', 'runtime', 0.83, 2]],
    'app-operation': [['app.inspect', 'uia', 0.88, 1], ['perception.ground', 'accessibility', 0.84, 1], ['visual.capture', 'visual', 0.72, 3]]
  };
  const configured = byKind[goal.kind] ?? [];
  const rows = configured.some(([capability]) => capability === controlCapability)
    ? configured
    : [[controlCapability, channelFor(controlCapability), 0.75, 1] as [string, ObservationCandidate['channel'], number, number], ...configured];
  return rows
    .filter(([capability]) => allowed.has(capability) && capabilityRiskRule(capability) === 'read')
    .filter(([capability], index, all) => all.findIndex(([candidate]) => candidate === capability) === index)
    .map(([capability, channel, expectedInformationGain, expectedCost]) => ({
      id: capability,
      channel,
      description: `Read-only ${channel} observation through ${capability}.`,
      resolvesFacts: [`goal:${goal.kind}:state`],
      expectedInformationGain,
      expectedCost,
      targetLocal,
      mutating: false
    }));
}

function observationBeliefs(goal: SemanticTaskGoal, intelligence: Parameters<TaskObservationShadowAdvisor['recommend']>[0]['intelligence'], now: Date): BeliefResolution[] {
  const facts: BeliefResolution[] = [];
  for (const entity of intelligence.world) {
    for (const fact of entity.facts) {
      facts.push({
        factKey: `${entity.entityKey}:${fact.key}`,
        status: fact.maxConfidence >= 0.99 ? 'KNOWN' : 'SUPPORTED',
        confidence: fact.maxConfidence,
        supportingEvidence: [], contradictingEvidence: [], staleEvidence: [], alternatives: [], updatedAt: fact.freshestAt ?? intelligence.retrievedAt
      });
    }
  }
  facts.push({
    factKey: `goal:${goal.kind}:state`, status: 'UNKNOWN', confidence: 0,
    supportingEvidence: [], contradictingEvidence: [], staleEvidence: [], alternatives: [], updatedAt: now.toISOString()
  });
  return facts;
}

function evidenceRefs(intelligence: Parameters<TaskObservationShadowAdvisor['recommend']>[0]['intelligence']) {
  const refs = new Map<string, { digest: string; source: string; observedAt: string; channel: string; independenceKey: string }>();
  for (const entity of intelligence.world) {
    for (const fact of entity.facts) {
      if (!fact.freshestAt || !Number.isFinite(Date.parse(fact.freshestAt))) continue;
      for (const digest of fact.evidenceDigests) {
        if (!/^[0-9a-f]{64}$/i.test(digest)) continue;
        refs.set(digest.toLowerCase(), {
          digest: digest.toLowerCase(), source: 'bounded-world-model', observedAt: new Date(Date.parse(fact.freshestAt)).toISOString(),
          channel: 'world-model', independenceKey: entity.entityKey
        });
      }
    }
  }
  return [...refs.values()];
}

function channelFor(capability: string): ObservationCandidate['channel'] {
  if (capability.startsWith('browser.')) return 'dom';
  if (capability === 'app.inspect') return 'uia';
  if (capability === 'visual.capture') return 'visual';
  return 'runtime';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
