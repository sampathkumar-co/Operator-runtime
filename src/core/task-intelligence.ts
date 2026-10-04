import crypto from 'node:crypto';
import type { SemanticTaskGoal, TaskIntelligenceContext, TaskIntelligenceProvider, TaskIntelligenceRequest } from './task-orchestrator.ts';
import type { ProcedureMemoryStore } from './procedure-memory.ts';
import type { WorldModelStore } from './world-model.ts';
import type { PerceptionGraphStore } from './perception-graph.ts';
import type { ExecutionOptimizerStore } from './execution-optimizer.ts';

const MAX_WORLD = 12;
const MAX_FACTS = 12;
const MAX_PROCEDURES = 5;
const MAX_PERCEPTION = 12;

export class BoundedTaskIntelligence implements TaskIntelligenceProvider {
  #world: WorldModelStore;
  #procedures: ProcedureMemoryStore;
  #perception: PerceptionGraphStore;
  #optimizer: ExecutionOptimizerStore;

  constructor(input: {
    world: WorldModelStore;
    procedures: ProcedureMemoryStore;
    perception: PerceptionGraphStore;
    optimizer: ExecutionOptimizerStore;
  }) {
    this.#world = input.world;
    this.#procedures = input.procedures;
    this.#perception = input.perception;
    this.#optimizer = input.optimizer;
  }

  async retrieve(request: TaskIntelligenceRequest): Promise<TaskIntelligenceContext> {
    const scopeKey = taskScopeKey(request.goal, request.task.authorizedScope);
    const sceneKey = taskSceneKey(request.goal);
    const [entities, procedures, scene] = await Promise.all([
      this.#world.listEntities({ scopeKey, limit: MAX_WORLD }),
      this.#procedures.findReusable({ objectiveKind: request.goal.kind, scopeKey, assumptions: [], maxResults: MAX_PROCEDURES }),
      sceneKey ? this.#perception.scene(sceneKey) : Promise.resolve([])
    ]);
    const candidates = [
      { id: 'fresh-plan', staticScore: 0.5 },
      ...procedures.map((candidate) => ({ id: `procedure:${candidate.procedure.id}`, staticScore: Math.max(0.5, candidate.confidence) }))
    ];
    const strategies = await this.#optimizer.recommend(`task:${request.goal.kind}`, candidates);
    return {
      retrievedAt: new Date().toISOString(),
      scopeKey,
      ...(sceneKey ? { sceneKey } : {}),
      world: entities.map((entity) => ({
        entityKey: entity.key,
        type: entity.type,
        updatedAt: entity.updatedAt,
        facts: entity.facts.slice(0, MAX_FACTS).map((fact) => ({
          key: fact.key,
          claimCount: fact.claims.length,
          freshestAt: fact.claims.map((claim) => claim.observedAt).sort().at(-1),
          maxConfidence: Math.max(0, ...fact.claims.map((claim) => claim.confidence)),
          evidenceDigests: [...new Set(fact.claims.map((claim) => claim.evidenceDigest))].slice(0, 3)
        }))
      })),
      procedures: procedures.map((candidate) => ({
        id: candidate.procedure.id,
        confidence: candidate.confidence,
        capabilities: [...new Set(candidate.procedure.steps.map((step) => step.capability))].slice(0, 20),
        verifiedRuns: candidate.procedure.verifiedRuns,
        failedRuns: candidate.procedure.failedRuns,
        verificationDigest: candidate.procedure.verificationDigest
      })),
      perception: scene.slice(0, MAX_PERCEPTION).map((target) => ({
        nodeId: target.node.id,
        ...(target.node.semanticId ? { semanticId: target.node.semanticId } : {}),
        confidence: target.confidence,
        channels: target.channels,
        ...(target.role ? { role: target.role.slice(0, 128) } : {}),
        ...(target.name ? { name: target.name.slice(0, 256) } : {}),
        ...(target.bounds ? { bounds: target.bounds } : {})
      })),
      strategies: strategies.slice(0, 10)
    };
  }
}

function taskScopeKey(goal: SemanticTaskGoal, authorizedScope: string[]): string {
  const raw = 'root' in goal && typeof goal.root === 'string' ? goal.root : authorizedScope[0];
  if (raw) {
    const normalized = raw.replaceAll('\\', '/');
    if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(normalized)) return normalized;
  }
  return `task:${crypto.createHash('sha256').update(JSON.stringify(authorizedScope)).digest('hex').slice(0, 32)}`;
}

function taskSceneKey(goal: SemanticTaskGoal): string | undefined {
  if (goal.kind === 'app-operation' && goal.selector.processId) return `uia:process:${goal.selector.processId}`;
  if (goal.kind === 'browser-navigation' && goal.targetId) return `browser:target:${goal.targetId}`;
  return undefined;
}
