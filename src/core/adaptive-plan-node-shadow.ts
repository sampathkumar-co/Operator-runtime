import crypto from 'node:crypto';
import {
  createDecisionLineage,
  digestBeliefs,
  digestPlan,
  rankPlanBranches,
  type PlanBranchCandidate
} from '../../packages/verified-plan-runtime/src/index.ts';
import { canonicalJson } from './action-identity.ts';
import { capabilityRiskRule } from './capability-policy.ts';
import type {
  TaskPlanNodeShadowAdvisor,
  TaskPlanNodeShadowRecommendation
} from './task-orchestrator.ts';
import type { ActionRisk } from './types.ts';

const POLICY_VERSION = 'verified-plan-node-shadow-v1';

/** Third progressive activation stage. Recommends capability identities only; never executable inputs. */
export class AdaptivePlanNodeShadowAdvisor implements TaskPlanNodeShadowAdvisor {
  #clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  recommend(input: Parameters<TaskPlanNodeShadowAdvisor['recommend']>[0]): TaskPlanNodeShadowRecommendation | undefined {
    if (!isLowRisk(input.risk)) return undefined;
    const allowed = new Set(input.permissions.allowedCapabilities);
    const candidates = planCandidates(input, allowed);
    if (candidates.length === 0) return undefined;
    const ranked = rankPlanBranches(candidates, {
      remainingCostBudget: Math.max(1, input.task.execution?.maxSteps ?? 1),
      maximumRisk: numericRisk('write')
    });
    const selected = ranked[0]!;
    const authoritySnapshotDigest = sha256(canonicalJson({
      allowedCapabilities: [...allowed].sort(),
      allowedRoots: [...new Set(input.permissions.allowedRoots)].sort(),
      maxRisk: input.permissions.maxRisk ?? null,
      allowExternalWrites: input.permissions.allowExternalWrites === true,
      allowSystemChanges: input.permissions.allowSystemChanges === true,
      allowDestructive: input.permissions.allowDestructive === true,
      enterprisePolicyDigest: input.permissions.enterprisePolicyDigest ?? null,
      enterprisePolicyGeneration: input.permissions.enterprisePolicyGeneration ?? null,
      intent: input.task.intent ?? null
    }));
    const planDigest = digestPlan({
      policyVersion: POLICY_VERSION,
      goalKind: input.goal.kind,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        capability: candidate.nodeIds[0],
        risk: candidate.risk,
        expectedSuccess: candidate.expectedSuccess,
        verificationStrength: candidate.verificationStrength
      })),
      procedureLineage: input.intelligence.procedures.map((procedure) => ({
        id: procedure.id,
        confidence: procedure.confidence,
        capabilities: [...procedure.capabilities].sort(),
        verifiedRuns: procedure.verifiedRuns,
        failedRuns: procedure.failedRuns,
        verificationDigest: procedure.verificationDigest
      })).sort((a, b) => a.id.localeCompare(b.id)),
      authoritySnapshotDigest
    });
    const beliefDigest = digestBeliefs({
      retrievedAt: input.intelligence.retrievedAt,
      scopeKey: input.intelligence.scopeKey,
      world: input.intelligence.world.map((entity) => ({
        entityKey: entity.entityKey,
        updatedAt: entity.updatedAt,
        facts: entity.facts.map((fact) => ({ key: fact.key, maxConfidence: fact.maxConfidence, evidenceDigests: fact.evidenceDigests }))
      }))
    });
    const inputStateDigest = sha256(canonicalJson({
      taskId: input.task.id,
      actionId: input.actionId,
      controlCapability: input.decision.capability,
      goalKind: input.goal.kind,
      planDigest,
      beliefDigest
    }));
    const decision = createDecisionLineage({
      planId: sha256(`${input.task.id}\0${POLICY_VERSION}`),
      planVersion: 1,
      planDigest,
      goalId: sha256(`${input.task.id}\0${input.goal.kind}`),
      nodeId: selected.nodeIds[0]!,
      beliefDigest,
      decisionKind: 'BRANCH',
      decisionId: selected.id,
      createdAt: this.#clock().toISOString()
    });
    return {
      mode: 'SHADOW',
      policyVersion: POLICY_VERSION,
      selectedCapability: selected.nodeIds[0]!,
      controlCapability: input.decision.capability,
      alternatives: ranked.map((candidate) => ({
        capability: candidate.nodeIds[0]!, utility: candidate.utility, risk: candidate.risk
      })),
      agreement: selected.nodeIds[0] === input.decision.capability,
      decisionDigest: decision.digest,
      authoritySnapshotDigest,
      inputStateDigest
    };
  }
}

function planCandidates(
  input: Parameters<TaskPlanNodeShadowAdvisor['recommend']>[0],
  allowed: Set<string>
): PlanBranchCandidate[] {
  const confidenceByCapability = new Map<string, { confidence: number; verificationStrength: number }>();
  if (allowed.has(input.decision.capability) && isLowRisk(input.risk)
    && riskWithinPermission(input.risk, input.permissions.maxRisk)) {
    confidenceByCapability.set(input.decision.capability, { confidence: 0.65, verificationStrength: 0.6 });
  }
  for (const procedure of input.intelligence.procedures) {
    const totalRuns = procedure.verifiedRuns + procedure.failedRuns;
    const verificationStrength = totalRuns === 0 ? 0.5 : Math.min(1, 0.5 + (procedure.verifiedRuns / totalRuns) * 0.5);
    for (const capability of procedure.capabilities) {
      if (!allowed.has(capability)) continue;
      const risk = staticLowRisk(capability);
      if (!risk || !riskWithinPermission(risk, input.permissions.maxRisk)) continue;
      const prior = confidenceByCapability.get(capability);
      const candidate = { confidence: clamp01(procedure.confidence), verificationStrength };
      if (!prior || candidate.confidence > prior.confidence) confidenceByCapability.set(capability, candidate);
    }
  }
  return [...confidenceByCapability.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([capability, scores]) => {
    const risk: 'read' | 'write' = capability === input.decision.capability && isLowRisk(input.risk)
      ? input.risk
      : staticLowRisk(capability)!;
    const read = risk === 'read';
    return {
      id: `node:${capability}`,
      nodeIds: [capability],
      expectedSuccess: scores.confidence,
      expectedInformationGain: read ? 0.8 : 0.25,
      expectedCost: read ? 1 : 2,
      risk: numericRisk(risk),
      uncertainty: clamp01(1 - scores.confidence),
      verificationStrength: scores.verificationStrength,
      reversibleFraction: read ? 1 : 0.65
    };
  });
}

function staticLowRisk(capability: string): 'read' | 'write' | undefined {
  try {
    const risk = capabilityRiskRule(capability);
    return risk === 'read' || risk === 'write' ? risk : undefined;
  } catch {
    return undefined;
  }
}

function isLowRisk(risk: ActionRisk): risk is 'read' | 'write' {
  return risk === 'read' || risk === 'write';
}

function riskWithinPermission(risk: 'read' | 'write', maximum: ActionRisk | undefined): boolean {
  if (!maximum) return risk === 'read';
  return riskRank(risk) <= riskRank(maximum);
}

function riskRank(risk: ActionRisk): number {
  return ({ read: 0, write: 1, external: 2, system: 3, destructive: 4 })[risk];
}

function numericRisk(risk: 'read' | 'write'): number {
  return risk === 'read' ? 0.05 : 0.25;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
