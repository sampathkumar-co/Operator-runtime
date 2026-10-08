import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import type { TaskCapsule } from './task.ts';

export type EvaluationCategory =
  | 'browser' | 'desktop' | 'developer' | 'office' | 'enterprise'
  | 'multi-agent' | 'multi-device' | 'recovery' | 'security' | 'long-running';

export interface EvaluationScenario {
  id: string;
  version: number;
  category: EvaluationCategory;
  title: string;
  contractDigest: string;
  requiredCapabilities: string[];
  chaosTags: string[];
  createdAt: string;
}

export interface EvaluationRun {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  runtimeVersion: string;
  sourceCommit: string;
  startedAt: string;
  finishedAt: string;
  claimedSuccess: boolean;
  verifiedSuccess: boolean;
  recoveredFailure: boolean;
  humanInterventions: number;
  actionCount: number;
  modelCalls: number;
  tokenCount: number;
  latencyMs: number;
  costMicros: number;
  fallbackCount: number;
  uncertainMutationCount: number;
  evidenceDigest: string;
  candidateDirty?: boolean;
  runnerHash?: string;
  taskId?: string;
  seed?: number;
  model?: string;
  provider?: string;
  modelConfigDigest?: string;
  environmentDigest?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  plannerCalls?: number;
  plannerIterations?: number;
  reobserves?: number;
  dispatchedActions?: number;
  reconciliationCount?: number;
  providerRetries?: number;
  verificationCount?: number;
  modelLatencyMs?: number;
  runtimeLatencyMs?: number;
  infrastructureFailures?: number;
  runtimeFailures?: number;
  modelFailures?: number;
  plannerFailures?: number;
  taskFailures?: number;
  observationCount?: number;
  visualCaptureCount?: number;
  zeroProgressActions?: number;
  duplicateActions?: number;
  retryCount?: number;
  successfulSubgoals?: number;
  attemptedSubgoals?: number;
  primaryFailure?: EvaluationFailureCause;
  secondaryFailures?: EvaluationFailureCause[];
  recoveryAttempts?: number;
  replans?: number;
  environmentActions?: number;
  verificationState?: 'verified' | 'failed' | 'pending';
}

export interface EvaluationFailureCause {
  source: 'planner' | 'provider' | 'verification' | 'policy' | 'infrastructure' | 'unknown';
  code: string;
  at: string;
  executionPhase?: string;
  sideEffectState?: string;
}

interface EvaluationState {
  version: 1;
  scenarios: EvaluationScenario[];
  runs: EvaluationRun[];
}

export interface EvaluationSummary {
  runs: number;
  claimedSuccesses: number;
  verifiedSuccesses: number;
  falseSuccesses: number;
  verifiedSuccessRate: number;
  falseSuccessRate: number;
  recoveredFailures: number;
  recoveryRate: number;
  humanInterventionRate: number;
  averageActions: number;
  averageModelCalls: number;
  averageTokens: number;
  averageLatencyMs: number;
  averageCostMicros: number;
  fallbackRate: number;
  uncertainMutationRate: number;
  p50TaskLatencyMs: number;
  p95TaskLatencyMs: number;
  p50Actions: number;
  p95Actions: number;
  p50Tokens: number;
  p95Tokens: number;
  infrastructureFailures: number;
  runtimeFailures: number;
  modelFailures: number;
  plannerFailures: number;
  taskFailures: number;
}

export interface EvaluationRegression {
  improved: string[];
  regressed: string[];
  baseline: EvaluationSummary;
  candidate: EvaluationSummary;
}

const MAX_SCENARIOS = 20_000;
const MAX_RUNS = 200_000;
const STORE_OPTIONS = {
  maxBytes: 64 * 1024 * 1024,
  errorCode: 'EVALUATION_STATE_CORRUPT',
  invalidMessage: 'Evaluation state is invalid.'
} as const;

export class EvaluationStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'evaluations.json');
  }

  async registerScenario(input: Omit<EvaluationScenario, 'createdAt'> & { createdAt?: string }): Promise<EvaluationScenario> {
    const scenario = normalizeScenario({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
    return await this.#mutate((state) => {
      const same = state.scenarios.find((item) => item.id === scenario.id && item.version === scenario.version);
      if (same) {
        if (canonicalJson(same) !== canonicalJson(scenario)) throw new OperatorError('EVALUATION_SCENARIO_CONFLICT', 'Scenario id/version already refers to different content.');
        return same;
      }
      if (state.scenarios.length >= MAX_SCENARIOS) throw new OperatorError('EVALUATION_LIMIT', 'Evaluation scenario limit reached.');
      state.scenarios.push(scenario);
      return scenario;
    });
  }

  async recordRun(input: EvaluationRun): Promise<EvaluationRun> {
    const run = normalizeRun(input);
    return await this.#mutate((state) => {
      const scenario = state.scenarios.find((item) => item.id === run.scenarioId && item.version === run.scenarioVersion);
      if (!scenario) throw new OperatorError('EVALUATION_SCENARIO_NOT_FOUND', 'Evaluation run references an unknown scenario version.');
      const same = state.runs.find((item) => item.id === run.id);
      if (same) {
        if (canonicalJson(same) !== canonicalJson(run)) throw new OperatorError('EVALUATION_RUN_CONFLICT', 'Evaluation run id already refers to different content.');
        return same;
      }
      if (state.runs.length >= MAX_RUNS) state.runs.splice(0, Math.max(1, Math.floor(MAX_RUNS * 0.05)));
      state.runs.push(run);
      return run;
    });
  }

  async summary(input: {
    runtimeVersion?: string;
    sourceCommit?: string;
    category?: EvaluationCategory;
    scenarioIds?: string[];
    since?: string;
  } = {}): Promise<EvaluationSummary> {
    await this.#serial;
    const state = await this.#read();
    const scenarioIds = input.scenarioIds ? new Set(input.scenarioIds.map((id) => scenarioId(id))) : undefined;
    const categoryScenarios = input.category
      ? new Set(state.scenarios.filter((scenario) => scenario.category === input.category).map((scenario) => scenario.id))
      : undefined;
    const since = input.since ? iso(input.since, 'since') : undefined;
    const runs = state.runs
      .filter((run) => !input.runtimeVersion || run.runtimeVersion === input.runtimeVersion)
      .filter((run) => !input.sourceCommit || run.sourceCommit === input.sourceCommit.toLowerCase())
      .filter((run) => !scenarioIds || scenarioIds.has(run.scenarioId))
      .filter((run) => !categoryScenarios || categoryScenarios.has(run.scenarioId))
      .filter((run) => !since || Date.parse(run.finishedAt) >= Date.parse(since));
    return summarize(runs);
  }

  async compare(input: {
    baseline: { runtimeVersion?: string; sourceCommit?: string };
    candidate: { runtimeVersion?: string; sourceCommit?: string };
    thresholds?: Partial<Record<'verifiedSuccessRate' | 'falseSuccessRate' | 'recoveryRate' | 'humanInterventionRate' | 'averageLatencyMs' | 'averageCostMicros', number>>;
  }): Promise<EvaluationRegression> {
    const baseline = await this.summary(input.baseline);
    const candidate = await this.summary(input.candidate);
    const threshold = {
      verifiedSuccessRate: 0.005,
      falseSuccessRate: 0.001,
      recoveryRate: 0.01,
      humanInterventionRate: 0.01,
      averageLatencyMs: 50,
      averageCostMicros: 1000,
      ...(input.thresholds ?? {})
    };
    const improved: string[] = [];
    const regressed: string[] = [];
    compareHigher('verifiedSuccessRate', baseline, candidate, threshold.verifiedSuccessRate, improved, regressed);
    compareLower('falseSuccessRate', baseline, candidate, threshold.falseSuccessRate, improved, regressed);
    compareHigher('recoveryRate', baseline, candidate, threshold.recoveryRate, improved, regressed);
    compareLower('humanInterventionRate', baseline, candidate, threshold.humanInterventionRate, improved, regressed);
    compareLower('averageLatencyMs', baseline, candidate, threshold.averageLatencyMs, improved, regressed);
    compareLower('averageCostMicros', baseline, candidate, threshold.averageCostMicros, improved, regressed);
    return { improved, regressed, baseline, candidate };
  }

  async #mutate<T>(fn: (state: EvaluationState) => T): Promise<T> {
    let output!: T;
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      output = fn(state);
      state.scenarios.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
      state.runs.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id));
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(output);
  }

  async #read(): Promise<EvaluationState> {
    try {
      const state = JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)) as EvaluationState;
      if (!state || state.version !== 1 || !Array.isArray(state.scenarios) || !Array.isArray(state.runs)
        || state.scenarios.length > MAX_SCENARIOS || state.runs.length > MAX_RUNS) throw new Error('shape');
      state.scenarios = state.scenarios.map(normalizeScenario);
      state.runs = state.runs.map(normalizeRun);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, scenarios: [], runs: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('EVALUATION_STATE_CORRUPT', 'Evaluation state could not be read.');
    }
  }
}

export function evaluationScenarioDigest(scenario: EvaluationScenario): string {
  return crypto.createHash('sha256').update(canonicalJson(normalizeScenario(scenario))).digest('hex');
}

export function evaluationRunFromTask(input: {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  runtimeVersion: string;
  sourceCommit: string;
  candidateDirty: boolean;
  runnerHash: string;
  task: TaskCapsule;
  seed: number;
  model: string;
  provider: string;
  modelConfigDigest: string;
  environmentDigest: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  plannerCalls?: number;
  modelLatencyMs?: number;
  runtimeLatencyMs?: number;
  costMicros?: number;
  infrastructureFailures?: number;
  modelFailures?: number;
}): EvaluationRun {
  const execution = input.task.execution;
  if (!execution?.startedAt) throw new OperatorError('EVALUATION_INPUT_INVALID', 'Task execution metadata is required for runtime-native evaluation.');
  const finishedAt = input.task.updatedAt;
  const records = execution.records;
  const inputTokens = input.inputTokens ?? 0;
  const cachedInputTokens = input.cachedInputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const reconciliationCount = (execution.plannerEvents ?? []).filter((event) => event.decision === 'RECONCILE').length;
  const replans = (execution.plannerEvents ?? []).filter((event) => event.decision === 'REPLAN').length;
  const providerRetries = records.reduce((count, record) => count + Math.max(0, record.attempt - 1), 0);
  const verificationCount = input.task.evidence.filter((item) => item.kind.includes('verification') && item.status === 'pass').length;
  const runtimeFailures = records.filter((record) => record.state === 'FAILED' && record.errorCode !== 'TASK_PLANNER_FAILED').length;
  const plannerFailures = input.task.failures.filter((failure) => failure.code.includes('PLANNER')).length;
  const planValue = execution.plannerState.durablePlan;
  const planSubgoals = planValue && typeof planValue === 'object' && !Array.isArray(planValue)
    && Array.isArray((planValue as Record<string, unknown>).subgoals)
    ? (planValue as { subgoals: Array<Record<string, unknown>> }).subgoals : [];
  const actionIdentities = records.map((record) => `${record.stepKey}\0${record.inputHash}`);
  const evidenceDigest = crypto.createHash('sha256').update(canonicalJson({
    taskId: input.task.id, state: input.task.state, records: records.map((record) => ({
      actionId: record.actionId, state: record.state,
      stateVersion: record.observation?.schemaVersion === 2 ? record.observation.stateVersion : undefined,
      sideEffectState: record.sideEffectState, executionPhase: record.executionPhase
    })), verification: input.task.evidence.filter((item) => item.kind.includes('verification')).map((item) => item.data)
  })).digest('hex');
  const failureTaxonomy = deriveFailureTaxonomy(input.task);
  return normalizeRun({
    id: input.id, scenarioId: input.scenarioId, scenarioVersion: input.scenarioVersion,
    runtimeVersion: input.runtimeVersion, sourceCommit: input.sourceCommit,
    startedAt: execution.startedAt, finishedAt,
    claimedSuccess: input.task.state === 'VERIFIED', verifiedSuccess: input.task.state === 'VERIFIED',
    recoveredFailure: input.task.evidence.some((item) => /recover|reconcil/i.test(item.kind)),
    humanInterventions: records.filter((record) => record.errorCode === 'APPROVAL_REQUIRED').length,
    actionCount: execution.dispatchedActions ?? execution.stepCount,
    modelCalls: input.plannerCalls ?? 0,
    tokenCount: inputTokens + outputTokens,
    latencyMs: Math.max(0, Date.parse(finishedAt) - Date.parse(execution.startedAt)),
    costMicros: input.costMicros ?? 0,
    fallbackCount: input.task.evidence.filter((item) => item.kind.includes('fallback') || item.kind.includes('reobserve')).length,
    uncertainMutationCount: records.filter((record) => record.sideEffectState === 'uncertain').length,
    evidenceDigest,
    candidateDirty: input.candidateDirty, runnerHash: input.runnerHash, taskId: input.task.id, seed: input.seed,
    model: input.model, provider: input.provider, modelConfigDigest: input.modelConfigDigest,
    environmentDigest: input.environmentDigest,
    inputTokens, cachedInputTokens, outputTokens, plannerCalls: input.plannerCalls ?? 0,
    plannerIterations: execution.plannerIterations ?? 0,
    reobserves: execution.preDispatchReobserves ?? 0,
    dispatchedActions: execution.dispatchedActions ?? execution.stepCount,
    reconciliationCount, providerRetries, verificationCount,
    modelLatencyMs: input.modelLatencyMs ?? 0, runtimeLatencyMs: input.runtimeLatencyMs ?? 0,
    infrastructureFailures: input.infrastructureFailures ?? 0,
    runtimeFailures, modelFailures: input.modelFailures ?? 0, plannerFailures,
    taskFailures: input.task.state === 'FAILED' ? 1 : 0,
    observationCount: records.filter((record) => record.observation !== undefined).length,
    visualCaptureCount: records.filter((record) => record.observation?.channel === 'visual').length,
    zeroProgressActions: (execution.plannerEvents ?? []).filter((event) => event.kind === 'ACTION_SUCCEEDED_BUT_NO_PROGRESS').length,
    duplicateActions: actionIdentities.length - new Set(actionIdentities).size,
    retryCount: providerRetries,
    successfulSubgoals: planSubgoals.filter((subgoal) => subgoal.status === 'VERIFIED').length,
    attemptedSubgoals: planSubgoals.filter((subgoal) => Number(subgoal.attempts ?? 0) > 0).length,
    ...failureTaxonomy,
    recoveryAttempts: reconciliationCount + (execution.preDispatchReobserves ?? 0) + replans + providerRetries,
    replans,
    environmentActions: execution.dispatchedActions ?? execution.stepCount,
    verificationState: input.task.state === 'VERIFIED' ? 'verified'
      : input.task.evidence.some((item) => item.kind.includes('verification') && item.status === 'fail') ? 'failed' : 'pending'
  });
}

export function deriveFailureTaxonomy(task: TaskCapsule): Pick<EvaluationRun, 'primaryFailure' | 'secondaryFailures'> {
  const execution = task.execution;
  const causes: Array<EvaluationFailureCause & { secondary: boolean; order: number }> = [];
  let order = 0;
  for (const record of execution?.records ?? []) {
    if (record.state !== 'FAILED' && record.state !== 'INTERRUPTED') continue;
    const code = record.errorCode ?? 'PROVIDER_EXECUTION_FAILED';
    causes.push({
      source: failureSource(code, 'provider'), code, at: record.finishedAt ?? record.startedAt,
      ...(record.executionPhase ? { executionPhase: record.executionPhase } : {}),
      ...(record.sideEffectState ? { sideEffectState: record.sideEffectState } : {}),
      secondary: isSecondaryFailure(code), order: order++
    });
  }
  for (const failure of task.failures) {
    causes.push({
      source: failureSource(failure.code, 'unknown'), code: failure.code, at: failure.at,
      secondary: isSecondaryFailure(failure.code), order: order++
    });
  }
  for (const item of task.evidence) {
    if (item.status !== 'fail') continue;
    const code = typeof item.data?.code === 'string' ? item.data.code : item.kind.toUpperCase();
    causes.push({
      source: failureSource(code, item.kind.includes('verification') ? 'verification' : 'infrastructure'),
      code, at: item.timestamp, secondary: isSecondaryFailure(code) || /audit|teardown|cleanup/i.test(item.kind), order: order++
    });
  }
  causes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);
  const primary = causes.find((cause) => !cause.secondary);
  const secondary = causes.filter((cause) => cause !== primary);
  const clean = ({ secondary: _secondary, order: _order, ...cause }: typeof causes[number]): EvaluationFailureCause => cause;
  return {
    ...(primary ? { primaryFailure: clean(primary) } : {}),
    ...(secondary.length > 0 ? { secondaryFailures: secondary.slice(0, 32).map(clean) } : {})
  };
}

function isSecondaryFailure(code: string): boolean {
  return /AUDIT|TEARDOWN|CLOSE|CLEANUP|SHUTDOWN/.test(code.toUpperCase());
}

function failureSource(code: string, fallback: EvaluationFailureCause['source']): EvaluationFailureCause['source'] {
  const upper = code.toUpperCase();
  if (upper.includes('PLANNER')) return 'planner';
  if (/VERIFY|VERIFICATION|POSTCONDITION/.test(upper)) return 'verification';
  if (/POLICY|AUTHORITY|APPROVAL|UNAUTHORIZED|DENIED/.test(upper)) return 'policy';
  if (/AUDIT|TEARDOWN|CLOSE|CLEANUP|RELAY|TRANSPORT|NETWORK/.test(upper)) return 'infrastructure';
  return fallback;
}

function summarize(runs: EvaluationRun[]): EvaluationSummary {
  const count = runs.length;
  if (count === 0) return {
    runs: 0, claimedSuccesses: 0, verifiedSuccesses: 0, falseSuccesses: 0,
    verifiedSuccessRate: 0, falseSuccessRate: 0, recoveredFailures: 0, recoveryRate: 0,
    humanInterventionRate: 0, averageActions: 0, averageModelCalls: 0, averageTokens: 0,
    averageLatencyMs: 0, averageCostMicros: 0, fallbackRate: 0, uncertainMutationRate: 0,
    p50TaskLatencyMs: 0, p95TaskLatencyMs: 0, p50Actions: 0, p95Actions: 0, p50Tokens: 0, p95Tokens: 0,
    infrastructureFailures: 0, runtimeFailures: 0, modelFailures: 0, plannerFailures: 0, taskFailures: 0
  };
  const claimedSuccesses = runs.filter((run) => run.claimedSuccess).length;
  const verifiedSuccesses = runs.filter((run) => run.verifiedSuccess).length;
  const falseSuccesses = runs.filter((run) => run.claimedSuccess && !run.verifiedSuccess).length;
  const recoveredFailures = runs.filter((run) => run.recoveredFailure).length;
  const failedOrRecovered = runs.filter((run) => !run.claimedSuccess || run.recoveredFailure).length;
  const sum = (selector: (run: EvaluationRun) => number) => runs.reduce((total, run) => total + selector(run), 0);
  return {
    runs: count,
    claimedSuccesses,
    verifiedSuccesses,
    falseSuccesses,
    verifiedSuccessRate: ratio(verifiedSuccesses, count),
    falseSuccessRate: ratio(falseSuccesses, Math.max(claimedSuccesses, 1)),
    recoveredFailures,
    recoveryRate: ratio(recoveredFailures, Math.max(failedOrRecovered, 1)),
    humanInterventionRate: ratio(runs.filter((run) => run.humanInterventions > 0).length, count),
    averageActions: sum((run) => run.actionCount) / count,
    averageModelCalls: sum((run) => run.modelCalls) / count,
    averageTokens: sum((run) => run.tokenCount) / count,
    averageLatencyMs: sum((run) => run.latencyMs) / count,
    averageCostMicros: sum((run) => run.costMicros) / count,
    fallbackRate: ratio(sum((run) => run.fallbackCount), Math.max(sum((run) => run.actionCount), 1)),
    uncertainMutationRate: ratio(sum((run) => run.uncertainMutationCount), Math.max(sum((run) => run.actionCount), 1)),
    p50TaskLatencyMs: percentile(runs.map((run) => run.latencyMs), 0.5),
    p95TaskLatencyMs: percentile(runs.map((run) => run.latencyMs), 0.95),
    p50Actions: percentile(runs.map((run) => run.actionCount), 0.5),
    p95Actions: percentile(runs.map((run) => run.actionCount), 0.95),
    p50Tokens: percentile(runs.map((run) => run.tokenCount), 0.5),
    p95Tokens: percentile(runs.map((run) => run.tokenCount), 0.95),
    infrastructureFailures: sum((run) => run.infrastructureFailures ?? 0),
    runtimeFailures: sum((run) => run.runtimeFailures ?? 0),
    modelFailures: sum((run) => run.modelFailures ?? 0),
    plannerFailures: sum((run) => run.plannerFailures ?? 0),
    taskFailures: sum((run) => run.taskFailures ?? 0)
  };
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function compareHigher(key: keyof EvaluationSummary, baseline: EvaluationSummary, candidate: EvaluationSummary, threshold: number, improved: string[], regressed: string[]): void {
  const diff = Number(candidate[key]) - Number(baseline[key]);
  if (diff > threshold) improved.push(String(key));
  else if (diff < -threshold) regressed.push(String(key));
}
function compareLower(key: keyof EvaluationSummary, baseline: EvaluationSummary, candidate: EvaluationSummary, threshold: number, improved: string[], regressed: string[]): void {
  const diff = Number(candidate[key]) - Number(baseline[key]);
  if (diff < -threshold) improved.push(String(key));
  else if (diff > threshold) regressed.push(String(key));
}

function normalizeScenario(input: EvaluationScenario): EvaluationScenario {
  return {
    id: scenarioId(input.id),
    version: boundedInt(input.version, 1, 1_000_000, 'scenario.version'),
    category: category(input.category),
    title: bounded(input.title, 1024, 'scenario.title'),
    contractDigest: digest(input.contractDigest, 'scenario.contractDigest'),
    requiredCapabilities: uniqueText(input.requiredCapabilities, 512, 256, 'scenario.requiredCapabilities'),
    chaosTags: uniqueText(input.chaosTags, 128, 128, 'scenario.chaosTags'),
    createdAt: iso(input.createdAt, 'scenario.createdAt')
  };
}
function normalizeRun(input: EvaluationRun): EvaluationRun {
  const startedAt = iso(input.startedAt, 'run.startedAt');
  const finishedAt = iso(input.finishedAt, 'run.finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new OperatorError('EVALUATION_INPUT_INVALID', 'Evaluation run finished before it started.');
  return {
    id: uuid(input.id, 'run.id'),
    scenarioId: scenarioId(input.scenarioId),
    scenarioVersion: boundedInt(input.scenarioVersion, 1, 1_000_000, 'run.scenarioVersion'),
    runtimeVersion: bounded(input.runtimeVersion, 128, 'run.runtimeVersion'),
    sourceCommit: shaCommit(input.sourceCommit),
    startedAt,
    finishedAt,
    claimedSuccess: input.claimedSuccess === true,
    verifiedSuccess: input.verifiedSuccess === true,
    recoveredFailure: input.recoveredFailure === true,
    humanInterventions: boundedInt(input.humanInterventions, 0, 1_000_000, 'run.humanInterventions'),
    actionCount: boundedInt(input.actionCount, 0, 100_000_000, 'run.actionCount'),
    modelCalls: boundedInt(input.modelCalls, 0, 100_000_000, 'run.modelCalls'),
    tokenCount: boundedInt(input.tokenCount, 0, Number.MAX_SAFE_INTEGER, 'run.tokenCount'),
    latencyMs: boundedInt(input.latencyMs, 0, Number.MAX_SAFE_INTEGER, 'run.latencyMs'),
    costMicros: boundedInt(input.costMicros, 0, Number.MAX_SAFE_INTEGER, 'run.costMicros'),
    fallbackCount: boundedInt(input.fallbackCount, 0, 100_000_000, 'run.fallbackCount'),
    uncertainMutationCount: boundedInt(input.uncertainMutationCount, 0, 100_000_000, 'run.uncertainMutationCount'),
    evidenceDigest: digest(input.evidenceDigest, 'run.evidenceDigest'),
    ...(input.candidateDirty === undefined ? {} : { candidateDirty: input.candidateDirty === true }),
    ...(input.runnerHash === undefined ? {} : { runnerHash: digest(input.runnerHash, 'run.runnerHash') }),
    ...(input.taskId === undefined ? {} : { taskId: uuid(input.taskId, 'run.taskId') }),
    ...(input.seed === undefined ? {} : { seed: boundedInt(input.seed, 0, 0xffff_ffff, 'run.seed') }),
    ...(input.model === undefined ? {} : { model: bounded(input.model, 256, 'run.model') }),
    ...(input.provider === undefined ? {} : { provider: bounded(input.provider, 256, 'run.provider') }),
    ...(input.modelConfigDigest === undefined ? {} : { modelConfigDigest: digest(input.modelConfigDigest, 'run.modelConfigDigest') }),
    ...(input.environmentDigest === undefined ? {} : { environmentDigest: digest(input.environmentDigest, 'run.environmentDigest') }),
    ...(input.primaryFailure === undefined ? {} : { primaryFailure: normalizeFailureCause(input.primaryFailure, 'run.primaryFailure') }),
    ...(input.secondaryFailures === undefined ? {} : { secondaryFailures: normalizeSecondaryFailures(input.secondaryFailures) }),
    ...(input.verificationState === undefined ? {} : { verificationState: verificationState(input.verificationState) }),
    ...optionalCounters(input)
  };
}

function optionalCounters(input: EvaluationRun): Partial<EvaluationRun> {
  const output: Record<string, number> = {};
  for (const key of [
    'inputTokens', 'cachedInputTokens', 'outputTokens', 'plannerCalls', 'plannerIterations', 'reobserves',
    'dispatchedActions', 'reconciliationCount', 'providerRetries', 'verificationCount', 'modelLatencyMs',
    'runtimeLatencyMs', 'infrastructureFailures', 'runtimeFailures', 'modelFailures', 'plannerFailures', 'taskFailures',
    'observationCount', 'visualCaptureCount', 'zeroProgressActions', 'duplicateActions', 'retryCount',
    'successfulSubgoals', 'attemptedSubgoals', 'recoveryAttempts', 'replans', 'environmentActions'
  ] as const) {
    if (input[key] !== undefined) output[key] = boundedInt(input[key], 0, Number.MAX_SAFE_INTEGER, `run.${key}`);
  }
  return output;
}
function normalizeSecondaryFailures(input: unknown): EvaluationFailureCause[] {
  if (!Array.isArray(input) || input.length > 32) throw new OperatorError('EVALUATION_INPUT_INVALID', 'run.secondaryFailures is invalid.');
  return input.map((item, index) => normalizeFailureCause(item as EvaluationFailureCause, `run.secondaryFailures[${index}]`));
}
function normalizeFailureCause(input: EvaluationFailureCause, label: string): EvaluationFailureCause {
  if (!input || typeof input !== 'object') throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} is invalid.`);
  const source = String(input.source);
  if (!['planner','provider','verification','policy','infrastructure','unknown'].includes(source)) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label}.source is invalid.`);
  return {
    source: source as EvaluationFailureCause['source'], code: bounded(input.code, 256, `${label}.code`), at: iso(input.at, `${label}.at`),
    ...(input.executionPhase === undefined ? {} : { executionPhase: bounded(input.executionPhase, 64, `${label}.executionPhase`) }),
    ...(input.sideEffectState === undefined ? {} : { sideEffectState: bounded(input.sideEffectState, 64, `${label}.sideEffectState`) })
  };
}
function verificationState(input: unknown): NonNullable<EvaluationRun['verificationState']> {
  if (!['verified', 'failed', 'pending'].includes(String(input))) throw new OperatorError('EVALUATION_INPUT_INVALID', 'run.verificationState is invalid.');
  return input as NonNullable<EvaluationRun['verificationState']>;
}
function category(input: unknown): EvaluationCategory {
  if (!['browser','desktop','developer','office','enterprise','multi-agent','multi-device','recovery','security','long-running'].includes(String(input))) {
    throw new OperatorError('EVALUATION_INPUT_INVALID', 'Evaluation category is invalid.');
  }
  return input as EvaluationCategory;
}
function ratio(a: number, b: number): number { return Math.round((b <= 0 ? 0 : a / b) * 1_000_000) / 1_000_000; }
function scenarioId(input: unknown): string {
  const value = bounded(input, 256, 'scenarioId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new OperatorError('EVALUATION_INPUT_INVALID', 'scenarioId is invalid.');
  return value;
}
function uniqueText(input: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} is invalid.`);
  const values = input.map((value, index) => bounded(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} contains duplicates.`);
  return values.sort();
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function boundedInt(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function shaCommit(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new OperatorError('EVALUATION_INPUT_INVALID', 'sourceCommit must be a 40-character Git SHA.');
  return value;
}
function uuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} must be UUID.`);
  return value;
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('EVALUATION_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
