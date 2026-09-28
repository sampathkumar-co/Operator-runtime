import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

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
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      output = fn(state);
      state.scenarios.sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
      state.runs.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id.localeCompare(b.id));
      await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
    });
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

function summarize(runs: EvaluationRun[]): EvaluationSummary {
  const count = runs.length;
  if (count === 0) return {
    runs: 0, claimedSuccesses: 0, verifiedSuccesses: 0, falseSuccesses: 0,
    verifiedSuccessRate: 0, falseSuccessRate: 0, recoveredFailures: 0, recoveryRate: 0,
    humanInterventionRate: 0, averageActions: 0, averageModelCalls: 0, averageTokens: 0,
    averageLatencyMs: 0, averageCostMicros: 0, fallbackRate: 0, uncertainMutationRate: 0
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
    uncertainMutationRate: ratio(sum((run) => run.uncertainMutationCount), Math.max(sum((run) => run.actionCount), 1))
  };
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
    evidenceDigest: digest(input.evidenceDigest, 'run.evidenceDigest')
  };
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
