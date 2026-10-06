import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, IntentBinding, PermissionProfile } from './types.ts';
import type { TaskCapsule, TaskObservationDomain } from './task.ts';
import type { TaskPlannerEvent } from './task-planner-event.ts';
import type { TaskDecisionBudget } from './task-decision-budget.ts';
import type { TaskStateAssertion } from './task-state-assertion.ts';
import type { RuntimeAdvisoryCommand } from './intelligence-adapters.ts';

export type UiaTaskOperation = 'invoke' | 'set_value' | 'focus' | 'select' | 'expand' | 'collapse' | 'scroll' | 'activate_window';
export type UiaTaskSelector = { name?: string; automationId?: string; className?: string; controlType?: string; processId?: number };
export type PhysicalInputTaskOperation = 'move' | 'click' | 'double_click' | 'drag' | 'scroll' | 'type_text' | 'key_press' | 'hotkey';
export type VisualTaskSelector = { name?: string; className?: string; processId?: number };
export type AppPhysicalFallback = {
  source: 'screen' | 'window' | 'region';
  selector?: VisualTaskSelector;
  region?: { x: number; y: number; width: number; height: number };
  operation: PhysicalInputTaskOperation;
  x?: number; y?: number; toX?: number; toY?: number;
  deltaX?: number; deltaY?: number;
  text?: string; key?: string; keys?: string[];
  maxWidth?: number; maxHeight?: number;
};
export type PostgresTaskFilter = { column: string; op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'is_null' | 'not_null'; value?: string };
export type PostgresTaskOrder = { column: string; direction: 'asc' | 'desc' };
export type ProjectQualityCheck = 'lint' | 'test' | 'build';
export type AutonomousTaskAction = { capability: string; input: Record<string, unknown>; target?: string };
export type AutonomousTaskStep = {
  key: string;
  title: string;
  parentKey?: string;
  dependsOn?: string[];
  resourceScope?: string[];
  observe: AutonomousTaskAction;
  action: AutonomousTaskAction;
  verify: AutonomousTaskAction & { assertions: TaskStateAssertion[] };
};

export type AtomicSemanticTaskGoal =
  | { kind: 'controlled-file-change'; root: string; path: string; content: string }
  | { kind: 'trusted-project-command'; root: string; commandKind: 'build' | 'test' | 'lint' }
  | { kind: 'browser-navigation'; url: string; targetId?: string }
  | { kind: 'docker-lifecycle'; root: string; operation: 'start' | 'stop' | 'restart'; services: string[]; timeoutMs?: number }
  | {
      kind: 'postgres-select'; root: string; profileId: string; schema?: string; table: string;
      columns?: string[]; filters?: PostgresTaskFilter[]; orderBy?: PostgresTaskOrder[];
      limit?: number; offset?: number; timeoutMs?: number;
    }
  | {
      kind: 'app-operation'; operation: UiaTaskOperation; selector: UiaTaskSelector;
      value?: string; horizontalAmount?: string; verticalAmount?: string;
      verifySelector?: UiaTaskSelector; waitMs?: number;
      physicalFallback?: AppPhysicalFallback;
    };

export type SemanticTaskGoal =
  | AtomicSemanticTaskGoal
  | { kind: 'project-quality-gate'; root: string; checks?: ProjectQualityCheck[]; requireAll?: boolean }
  | { kind: 'semantic-workflow'; steps: AtomicSemanticTaskGoal[] }
  | { kind: 'autonomous-workflow'; roots?: string[]; browserOrigins?: string[]; application?: boolean; steps: AutonomousTaskStep[] };

export interface TaskPlannerContext {
  task: TaskCapsule;
  goal: SemanticTaskGoal;
  budget: {
    maxSteps: number;
    usedSteps: number;
    remainingSteps: number;
    plannerIterations: number;
    preDispatchReobserves: number;
    dispatchedActions: number;
    maxAttemptsPerStep: number;
    activeDeadlineMsRemaining: number;
  };
  recentEvents: TaskPlannerEvent[];
  intelligence: TaskIntelligenceContext;
  decisionBudget: TaskDecisionBudget;
}

export interface TaskIntelligenceContext {
  retrievedAt: string;
  scopeKey: string;
  sceneKey?: string;
  world: Array<{
    entityKey: string; type: string; updatedAt: string;
    facts: Array<{ key: string; claimCount: number; freshestAt?: string; maxConfidence: number; evidenceDigests: string[] }>;
  }>;
  procedures: Array<{
    id: string; confidence: number; capabilities: string[]; verifiedRuns: number; failedRuns: number; verificationDigest: string;
  }>;
  perception: Array<{
    nodeId: string; semanticId?: string; confidence: number; channels: string[]; role?: string; name?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  strategies: Array<{ id: string; score: number; staticScore: number; learnedAdjustment: number; samples: number }>;
}

export interface TaskIntelligenceRequest {
  task: TaskCapsule;
  goal: SemanticTaskGoal;
  budget: TaskPlannerContext['budget'];
  recentEvents: TaskPlannerEvent[];
}

export interface TaskIntelligenceProvider {
  retrieve(request: TaskIntelligenceRequest): Promise<TaskIntelligenceContext>;
}

export interface TaskPlanningInfluence {
  command: RuntimeAdvisoryCommand;
  effect: 'SHADOW_ONLY' | 'ADVISORY_ONLY' | 'CONTROL_ALLOWED' | 'CONTROL_BLOCKED';
  reason: string;
  proposalDigest?: string;
  grantsAuthority: false;
  runtimeVetoRequired: true;
}

export interface TaskPlanningInfluenceRequest {
  proposalDigest: string;
  task: TaskCapsule;
  goal: SemanticTaskGoal;
  decision: Extract<PlannerDecision, { type: 'step' }>;
  risk: ActionRisk;
  budget: TaskPlannerContext['budget'];
  recentEvents: TaskPlannerEvent[];
  intelligence: TaskIntelligenceContext;
  decisionBudget: TaskDecisionBudget;
}

export interface TaskPlanningInfluenceProvider {
  review(request: TaskPlanningInfluenceRequest): Promise<TaskPlanningInfluence | undefined>;
}

/** Stable semantic observation boundary. A future visual provider can populate the
 * same contract with channel="visual" without changing planner control flow. */
export interface TaskObservation {
  channel: 'semantic' | 'visual';
  domain: TaskObservationDomain;
  observedAt: string;
  ok: boolean;
  capability: string;
  provider: string;
  output?: unknown;
  evidence: ActionResult['evidence'];
  error?: ActionResult['error'];
}

export type PlannerDecision =
  | { type: 'complete'; message: string }
  | { type: 'step'; key: string; title: string; capability: string; input: Record<string, unknown>; target?: string };

export interface TaskPlanner {
  readonly id: string;
  supports(goal: SemanticTaskGoal): boolean;
  next(context: TaskPlannerContext): PlannerDecision;
  repair?(context: TaskPlannerContext, invalidDecision: unknown, issue: string): PlannerDecision;
  accept(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): void;
  fallback?(context: TaskPlannerContext, step: Extract<PlannerDecision, { type: 'step' }>, observation: TaskObservation): boolean;
}

export interface TaskRunAuthorization {
  permissionProvider?: (action: ActionRequest) => PermissionProfile | Promise<PermissionProfile>;
  onActionResult?: (action: ActionRequest, result: ActionResult) => void | Promise<void>;
  onApprovalRequired?: (
    action: ActionRequest,
    remainingMs: number
  ) => 'retry' | 'deny' | void | Promise<'retry' | 'deny' | void>;
}

export interface SubmitTaskOptions {
  requestId?: string;
  objective: string;
  authorizedScope: string[];
  prohibitedScope?: string[];
  successConditions: string[];
  goal: SemanticTaskGoal;
  maxSteps?: number;
  maxAttemptsPerStep?: number;
  timeoutMs?: number;
  intent?: IntentBinding;
}

export type TaskExecuteAction = (
  action: ActionRequest,
  permissions: PermissionProfile,
  context?: CapabilityExecutionContext
) => Promise<ActionResult>;
