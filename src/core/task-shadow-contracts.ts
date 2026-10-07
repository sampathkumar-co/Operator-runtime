import type { TaskCapsule, TaskObservationSummaryV2 } from './task.ts';
import type { TaskFailureDecision } from './task-failure.ts';
import type {
  PlannerDecision,
  SemanticTaskGoal,
  TaskIntelligenceContext
} from './task-orchestrator-contracts.ts';
import type { ActionResult, ActionRisk, ExecutionPhase, PermissionProfile, SideEffectState } from './types.ts';

export interface TaskObservationShadowRecommendation {
  mode: 'SHADOW';
  policyVersion: string;
  selectedId: string;
  controlId: string;
  alternatives: string[];
  agreement: boolean;
  decisionDigest: string;
  authoritySnapshotDigest: string;
}

export interface TaskObservationShadowAdvisor {
  recommend(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    risk: ActionRisk;
    intelligence: TaskIntelligenceContext;
    permissions: PermissionProfile;
  }): TaskObservationShadowRecommendation | undefined | Promise<TaskObservationShadowRecommendation | undefined>;
}

export interface TaskPlanNodeShadowRecommendation {
  mode: 'SHADOW';
  policyVersion: string;
  selectedCapability: string;
  controlCapability: string;
  alternatives: Array<{ capability: string; utility: number; risk: number }>;
  agreement: boolean;
  decisionDigest: string;
  authoritySnapshotDigest: string;
  inputStateDigest: string;
}

export interface TaskPlanNodeShadowAdvisor {
  recommend(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    risk: ActionRisk;
    intelligence: TaskIntelligenceContext;
    permissions: PermissionProfile;
  }): TaskPlanNodeShadowRecommendation | undefined | Promise<TaskPlanNodeShadowRecommendation | undefined>;
}

export interface TaskOutcomeShadowAssessment {
  mode: 'SHADOW';
  policyVersion: string;
  progress: {
    level: 'NONE' | 'ACTION_EXECUTED' | 'STATE_CHANGED' | 'SUBGOAL_PROGRESS' | 'GOAL_ACHIEVED';
    confidence: number;
    creditedSignals: string[];
    rejectedSignals: string[];
    verificationRequired: boolean;
  };
  failure?: {
    primaryClass: string;
    probability: number;
    alternatives: Array<{ class: string; probability: number }>;
    entropy: number;
    evidenceCoverage: number;
  };
  decisionDigest: string;
  authoritySnapshotDigest: string;
  inputStateDigest: string;
}

export interface TaskOutcomeShadowAdvisor {
  analyze(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    risk: ActionRisk;
    permissions: PermissionProfile;
    result: ActionResult;
    observation: TaskObservationSummaryV2;
    previousObservation?: TaskObservationSummaryV2;
    sideEffectState: SideEffectState;
    executionPhase: ExecutionPhase;
    productionFailure?: TaskFailureDecision;
  }): TaskOutcomeShadowAssessment | undefined | Promise<TaskOutcomeShadowAssessment | undefined>;
}

export type TaskRecoveryShadowKind =
  | 'REOBSERVE'
  | 'REGROUND'
  | 'REPLAN'
  | 'REPAIR'
  | 'RECONCILE'
  | 'WAIT'
  | 'VERIFY'
  | 'FAIL_SAFE';

export interface TaskRecoveryShadowRecommendation {
  schemaVersion: 1;
  mode: 'SHADOW';
  policyVersion: string;
  taskId: string;
  goalKind: SemanticTaskGoal['kind'];
  planId: string;
  planVersion: number;
  planDigest: string;
  failedNodeId: string;
  actionId: string;
  attempt: number;
  observationDigest: string;
  verificationResultDigest: string;
  authoritySnapshotDigest: string;
  authorityGeneration: number | null;
  inputStateDigest: string;
  failureClass: string;
  selected: { id: string; kind: TaskRecoveryShadowKind };
  alternatives: Array<{ id: string; kind: TaskRecoveryShadowKind }>;
  productionStrategy: TaskFailureDecision['strategy'];
  semanticLoopCount: number;
  recommendationDigest: string;
}

export interface TaskRecoveryShadowAdvisor {
  recommend(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    failedNodeId: string;
    attempt: number;
    risk: ActionRisk;
    permissions: PermissionProfile;
    result: ActionResult;
    observation: TaskObservationSummaryV2;
    sideEffectState: SideEffectState;
    executionPhase: ExecutionPhase;
    productionFailure: TaskFailureDecision;
    outcomeAssessment?: TaskOutcomeShadowAssessment;
  }): TaskRecoveryShadowRecommendation | undefined | Promise<TaskRecoveryShadowRecommendation | undefined>;
}

export type TaskExecutionModality =
  | 'GUI'
  | 'DOM'
  | 'ACCESSIBILITY'
  | 'UIA'
  | 'PLAYWRIGHT'
  | 'APPLICATION'
  | 'API'
  | 'MCP'
  | 'TERMINAL'
  | 'OBSERVE';

export interface TaskModalityShadowAssessment {
  schemaVersion: 1;
  mode: 'SHADOW';
  policyVersion: string;
  taskId: string;
  actionId: string;
  capability: string;
  recommendedModality: TaskExecutionModality;
  actualProductionModality: TaskExecutionModality;
  candidates: Array<{
    modality: TaskExecutionModality;
    available: boolean;
    predictedSuccess: number;
    predictedRisk: number;
    predictedCost: number;
    verificationStrength: number;
    utility: number | null;
  }>;
  actualOutcome: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';
  verificationResult: 'SUPPORTED' | 'FAILED' | 'UNRESOLVED';
  recoveryCost: number;
  latencyMs: number;
  failureAttribution: string | null;
  switchAllowed: boolean;
  authoritySnapshotDigest: string;
  observationDigest: string;
  inputStateDigest: string;
  assessmentDigest: string;
}

export interface TaskModalityShadowAdvisor {
  assess(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    risk: ActionRisk;
    intelligence: TaskIntelligenceContext;
    permissions: PermissionProfile;
    result: ActionResult;
    observation: TaskObservationSummaryV2;
    sideEffectState: SideEffectState;
    executionPhase: ExecutionPhase;
    productionFailure?: TaskFailureDecision;
    outcomeAssessment?: TaskOutcomeShadowAssessment;
    recoveryRecommendation?: TaskRecoveryShadowRecommendation;
  }): TaskModalityShadowAssessment | undefined | Promise<TaskModalityShadowAssessment | undefined>;
}

export type TaskStrategyShadowKind =
  | 'CONTINUE_CURRENT_BRANCH'
  | 'OBSERVE_THEN_CONTINUE'
  | 'LOCAL_REPAIR'
  | 'ALTERNATIVE_BRANCH'
  | 'GLOBAL_REPLAN'
  | 'RECONCILE'
  | 'VERIFY'
  | 'WAIT'
  | 'STOP_UNRESOLVED';

export interface TaskStrategyShadowAssessment {
  schemaVersion: 1;
  mode: 'SHADOW';
  policyVersion: string;
  taskId: string;
  actionId: string;
  decisionKey: string;
  planId: string;
  planVersion: number;
  planDigest: string;
  authorityGeneration: number | null;
  authoritySnapshotDigest: string;
  observationDigest: string;
  verificationDigest: string;
  inputStateDigest: string;
  recommendedStrategy: TaskStrategyShadowKind;
  productionStrategy: TaskStrategyShadowKind;
  candidates: Array<{
    kind: TaskStrategyShadowKind;
    utility: number;
    expectedSuccess: number;
    expectedCost: number;
    uncertainty: number;
    verificationStrength: number;
    penalties: string[];
  }>;
  semanticLoopCount: number;
  controlAllowed: false;
  assessmentDigest: string;
}

export interface TaskStrategyShadowAdvisor {
  assess(input: {
    task: TaskCapsule;
    goal: SemanticTaskGoal;
    decision: Extract<PlannerDecision, { type: 'step' }>;
    actionId: string;
    risk: ActionRisk;
    intelligence: TaskIntelligenceContext;
    permissions: PermissionProfile;
    result: ActionResult;
    observation: TaskObservationSummaryV2;
    sideEffectState: SideEffectState;
    executionPhase: ExecutionPhase;
    productionFailure?: TaskFailureDecision;
    outcomeAssessment?: TaskOutcomeShadowAssessment;
    recoveryRecommendation?: TaskRecoveryShadowRecommendation;
    modalityAssessment?: TaskModalityShadowAssessment;
  }): TaskStrategyShadowAssessment | undefined | Promise<TaskStrategyShadowAssessment | undefined>;
}
