import type { TaskExecution } from './task.ts';

export interface TaskDecisionBudgetDimension { used: number; limit: number; remaining: number }
export interface TaskDecisionBudget {
  modelCalls: TaskDecisionBudgetDimension;
  tokens: TaskDecisionBudgetDimension;
  estimatedCostMicros: TaskDecisionBudgetDimension;
  plannerIterations: TaskDecisionBudgetDimension;
  environmentActions: TaskDecisionBudgetDimension;
  readObservations: TaskDecisionBudgetDimension;
  visualCaptures: TaskDecisionBudgetDimension;
  reobserves: TaskDecisionBudgetDimension;
  retries: TaskDecisionBudgetDimension;
  reconciliations: TaskDecisionBudgetDimension;
  elapsedMs: TaskDecisionBudgetDimension;
}

export function taskDecisionBudget(execution: TaskExecution, nowMs: number): TaskDecisionBudget {
  const plannerLimit = Math.max(4, execution.maxSteps * 4);
  const observationLimit = Math.max(execution.maxSteps, Math.ceil(execution.maxSteps * 1.5));
  const retryLimit = execution.maxSteps * Math.max(0, execution.maxAttemptsPerStep - 1);
  const records = execution.records;
  const events = execution.plannerEvents ?? [];
  const startedAt = execution.startedAt ? Date.parse(execution.startedAt) : nowMs;
  return {
    // Built-in Task planners are deterministic. Model-backed adapters must
    // charge these dimensions before returning a PlannerDecision.
    modelCalls: dimension(0, Math.max(1, execution.maxSteps * 2)),
    tokens: dimension(0, Math.max(1, execution.maxSteps * 100_000)),
    estimatedCostMicros: dimension(0, Math.max(1, execution.maxSteps * 1_000_000)),
    plannerIterations: dimension(execution.plannerIterations ?? 0, plannerLimit),
    environmentActions: dimension(execution.dispatchedActions ?? execution.stepCount, execution.maxSteps),
    readObservations: dimension(records.filter((record) => record.risk === 'read' && record.observation !== undefined).length, observationLimit),
    visualCaptures: dimension(records.filter((record) => record.observation?.channel === 'visual').length, execution.maxSteps),
    reobserves: dimension(execution.preDispatchReobserves ?? 0, execution.maxSteps),
    retries: dimension(records.filter((record) => record.attempt > 1).length, retryLimit),
    reconciliations: dimension(events.filter((event) => event.decision === 'RECONCILE').length, execution.maxSteps),
    elapsedMs: dimension(Math.max(0, nowMs - startedAt), execution.timeoutMs)
  };
}

export function decisionBudgetExhaustion(budget: TaskDecisionBudget): string | undefined {
  for (const [name, value] of Object.entries(budget)) if (value.limit > 0 && value.remaining === 0 && value.used >= value.limit) return name;
  return undefined;
}

function dimension(usedInput: number, limitInput: number): TaskDecisionBudgetDimension {
  const used = Math.max(0, Math.floor(usedInput));
  const limit = Math.max(0, Math.floor(limitInput));
  return { used, limit, remaining: Math.max(0, limit - used) };
}
