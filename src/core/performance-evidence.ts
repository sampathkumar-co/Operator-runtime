export interface PerformanceControlEvidence {
  phase: number;
  control: string;
  implementationFile: string;
  implementationSymbol: string;
  executableTestFile: string;
  executableTestName: string;
  status: 'EXECUTABLE';
}

const E = (phase: number, control: string, implementationFile: string, implementationSymbol: string, executableTestFile: string, executableTestName: string): PerformanceControlEvidence => ({
  phase, control, implementationFile, implementationSymbol, executableTestFile, executableTestName, status: 'EXECUTABLE'
});

export const PERFORMANCE_CONTROL_EVIDENCE: readonly PerformanceControlEvidence[] = [
  E(1, 'durable hierarchical plan', 'src/core/task-plan.ts', 'createDurableTaskPlan', 'test/task-plan.test.ts', 'durable task plan advances only dependency-ready subgoals and survives normalization'),
  E(2, 'machine success contracts', 'src/core/task-orchestrator.ts', 'assertTaskMachineState', 'test/task-orchestrator.test.ts', 'generic autonomous workflow observes, mutates through the kernel boundary, and independently verifies durable machine state'),
  E(3, 'state-delta-first replan', 'src/core/task-planner-event.ts', 'ACTION_SUCCEEDED_BUT_NO_PROGRESS', 'test/task-reobserve.test.ts', 'no-progress becomes a durable planner event and triggers bounded replanning without blind mutation retry'),
  E(4, 'multidimensional decision budget', 'src/core/task-decision-budget.ts', 'taskDecisionBudget', 'test/task-decision-budget.test.ts', 'decision budget separately accounts durable observations, retries, reconciliation and elapsed time'),
  E(5, 'observation economy', 'src/core/task-orchestrator.ts', 'early_outcome_completion', 'test/task-orchestrator.test.ts', 'typed outcome truth stops browser navigation when the destination is already satisfied'),
  E(6, 'deterministic model-call economy', 'src/core/task-verifier.ts', 'verifyGoalOutcomeTruth', 'test/task-stage3.test.ts', 'independent typed outcome verification rejects planner completion when machine state is false'),
  E(7, 'bounded relevant context', 'src/core/task-intelligence.ts', 'BoundedTaskIntelligence', 'test/task-intelligence.test.ts', 'Task intelligence retrieval is bounded, relevant, and omits raw world values'),
  E(8, 'confidence-driven observation', 'src/core/perception-graph.ts', 'correlationKey', 'test/perception-graph.test.ts', 'correlated observations do not manufacture confidence through repetition'),
  E(9, 'bounded failure strategy learning', 'src/core/execution-optimizer.ts', 'strategyAdjustment', 'test/execution-optimizer.test.ts', 'stage9 learning requires repeated evidence before changing ranking materially'),
  E(10, 'transactional code repair loop', 'src/core/task-orchestrator.ts', 'ProjectQualityGatePlanner', 'test/task-stage3.test.ts', 'stage3 mutating quality check runs transactionally and rolls back false-green output'),
  E(11, 'hostile UI targeting', 'src/capabilities/browser-cdp-page.ts', 'actionable', 'test/browser-dom.test.ts', 'ambiguous, hidden, disabled, and pointer-events-none custom controls fail closed'),
  E(12, 'exact focus ownership', 'src/capabilities/windows-uia.ts', '#captureLeases', 'test/windows-uia.test.ts', 'physical input requires a live SHA-bound visual capture lease before sidecar dispatch'),
  E(13, 'model configuration provenance', 'src/core/evaluation.ts', 'modelConfigDigest', 'test/evaluation.test.ts', 'runtime-native evaluation derives action, planner, retry, reconciliation, verification and failure telemetry from durable Task truth'),
  E(14, 'action efficiency metrics', 'src/core/evaluation.ts', 'zeroProgressActions', 'test/evaluation.test.ts', 'runtime-native evaluation derives action, planner, retry, reconciliation, verification and failure telemetry from durable Task truth'),
  E(15, 'performance and fluidity gate', 'performance/performance.test.ts', 'performance', 'performance/performance.test.ts', 'policy authorization remains comfortably sub-millisecond at scale')
] as const;
