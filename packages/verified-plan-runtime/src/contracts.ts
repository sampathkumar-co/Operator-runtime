export type EpistemicStatus =
  | 'KNOWN'
  | 'SUPPORTED'
  | 'CONFLICTED'
  | 'STALE'
  | 'UNKNOWN'
  | 'UNOBSERVABLE'
  | 'DISPROVEN';

export type ConstraintStrength = 'MUST' | 'SHOULD' | 'MAY' | 'MUST_NOT';

export interface GoalConstraint {
  id: string;
  strength: ConstraintStrength;
  factKey: string;
  expectedValueDigest?: string;
  description: string;
}

export interface CompiledGoal {
  id: string;
  kind: string;
  objective: string;
  successFactKeys: string[];
  forbiddenFactKeys: string[];
  constraints: GoalConstraint[];
  unresolvedAssumptions: string[];
}

export interface BeliefView {
  factKey: string;
  status: EpistemicStatus;
  confidence: number;
  selectedValueDigest?: string;
  evidenceDigests: string[];
}

export type PlanNodeKind = 'GOAL' | 'SUBGOAL' | 'OBSERVE' | 'ACTION' | 'VERIFY' | 'DECISION';
export type PlanNodeStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'BLOCKED'
  | 'INVALIDATED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED';

export interface PlanPrecondition {
  factKey: string;
  expectedValueDigest?: string;
  minimumConfidence?: number;
  allowStale?: boolean;
}

export interface PlanNode {
  id: string;
  kind: PlanNodeKind;
  title: string;
  parentId?: string;
  dependsOn: string[];
  choiceGroup?: string;
  preconditions: PlanPrecondition[];
  expectedEffects: string[];
  verificationFactKeys: string[];
  allowedCapabilities: string[];
  expectedCost: number;
  risk: number;
  reversible: boolean;
  maxAttempts: number;
}

export interface PlanGraph {
  planId: string;
  goalId: string;
  version: number;
  rootNodeIds: string[];
  nodes: PlanNode[];
}

export interface PlanNodeState {
  nodeId: string;
  status: PlanNodeStatus;
  attempts: number;
  lastReason?: string;
  lastExecutionDigest?: string;
  verificationReceiptDigest?: string;
  lastUpdatedAt: string;
}

export interface PlanBranchCandidate {
  id: string;
  nodeIds: string[];
  expectedSuccess: number;
  expectedInformationGain: number;
  expectedCost: number;
  risk: number;
  uncertainty: number;
  verificationStrength: number;
  reversibleFraction: number;
}

export interface RankedPlanBranch extends PlanBranchCandidate {
  utility: number;
  penalties: string[];
}

export type ExecutionModality =
  | 'GUI'
  | 'DOM'
  | 'ACCESSIBILITY'
  | 'UIA'
  | 'PLAYWRIGHT'
  | 'APPLICATION'
  | 'API'
  | 'MCP'
  | 'OBSERVE';

export interface ExecutionCandidate {
  id: string;
  modality: ExecutionModality;
  capability: string;
  expectedSuccess: number;
  expectedCost: number;
  uncertainty: number;
  verificationStrength: number;
  mutating: boolean;
  supportsRollback: boolean;
}

export interface RankedExecutionCandidate extends ExecutionCandidate {
  utility: number;
  penalties: string[];
}

export interface AuthorizationReceiptRef {
  digest: string;
  goalId: string;
  planId: string;
  planVersion: number;
  nodeId: string;
  authoritySnapshotDigest: string;
  authorizedAt: string;
}

export interface VerificationReceiptRef {
  digest: string;
  goalId: string;
  planId: string;
  planVersion: number;
  nodeId: string;
  attempt: number;
  executionDigest: string;
  verifierId: string;
  verifiedAt: string;
  authoritySnapshotDigest: string;
}

export interface ExecutionObservation {
  changedFactKeys: string[];
  supportedFactKeys: string[];
  contradictedFactKeys: string[];
  executionOk: boolean;
  sideEffectState: 'none' | 'known' | 'uncertain';
  evidenceDigests?: string[];
}

export interface PlanRepairDecision {
  failedNodeId: string;
  invalidatedNodeIds: string[];
  preservedSucceededNodeIds: string[];
  reason: string;
}

export type InfeasibilityClass =
  | 'NONE'
  | 'CAPABILITY_MISSING'
  | 'AUTHORITY_DENIED'
  | 'CONSTRAINT_CONTRADICTION'
  | 'DEPENDENCY_IMPOSSIBLE'
  | 'REQUIRED_STATE_UNOBSERVABLE'
  | 'BUDGET_EXHAUSTED'
  | 'INSUFFICIENT_EVIDENCE';

export interface InfeasibilityAssessment {
  class: InfeasibilityClass;
  confidence: number;
  terminal: boolean;
  evidence: string[];
  reason: string;
}

export interface PlanDecisionLineage {
  digest: string;
  planId: string;
  planVersion: number;
  planDigest: string;
  goalId: string;
  nodeId: string;
  beliefDigest: string;
  decisionKind: 'BRANCH' | 'EXECUTION' | 'REPAIR' | 'COMMIT' | 'INFEASIBLE';
  decisionId: string;
  createdAt: string;
}
