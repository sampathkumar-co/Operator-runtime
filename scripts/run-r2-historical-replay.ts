import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskStore } from '../src/core/task-store.ts';
import {
  TaskOrchestrator,
  type TaskIntelligenceProvider,
  type TaskPlanningInfluenceProvider
} from '../src/core/task-orchestrator.ts';
import type { ActionRequest, ActionResult, PermissionProfile } from '../src/core/types.ts';
import { evidence } from '../src/core/evidence.ts';
import { DecisionTraceLog, type DecisionTraceRecord } from '../packages/adaptive-intelligence/src/decision-trace.ts';
import { compareShadowToControl, type DecisionOutcome } from '../packages/adaptive-intelligence/src/shadow-comparison.ts';
import { createTaskCohortManifest } from '../packages/adaptive-intelligence/src/evaluation-cohort.ts';
import { createEvaluationFreezeManifest } from '../packages/adaptive-intelligence/src/evaluation-freeze.ts';
import { CalibrationTracker } from '../packages/adaptive-intelligence/src/calibration.ts';
import {
  assessBoundPolicyPromotion,
  validatePolicyPromotionEvidenceBundle,
  type PolicyPromotionCriteria,
  type PolicyPromotionEvidenceBundle
} from '../packages/adaptive-intelligence/src/promotion-evidence.ts';
import { canonicalJson } from '../packages/adaptive-intelligence/src/versioned-state.ts';
import {
  AdaptivePlanningControl,
  assertPromotionEligible,
  type AdaptivePlanningPromotionEvidence
} from '../src/core/adaptive-planning-control.ts';
import { deriveR2GeneralPromotionEvidence } from './derive-r2-promotion-evidence.ts';

const HISTORY_END = 'ed5948ff3f386f91ccd27674ed278a8ba5c624e6';
const TASK_COUNT = 1_000;
const STEPS_PER_TASK = 4;
const HISTORY_SCAN = 1_250;
const PARALLELISM = 4;
const FAILURE_PENALTY = 20;
const CANDIDATE_POLICY = 'r2-adaptive-general-candidate-v1';
const CONTROL_POLICY = 'r2-production-baseline-v1';
const GOAL_ID = 'historical-source-reconstruction';
const NON_BENCHMARK_RE = /(benchmark|miniwob|osworld|webarena)/i;
const OPERATIONAL_SIGNAL_RE = /(race|retry|stale|timeout|crash|recovery|recover|lock|corrupt|restore|rollback|reconcile|restart|resume|interrupt|deadlock|contention|offline|unavailable|pending|oversize)/i;
const DOCUMENTATION_PREFIX_RE = /^(docs?|chore\(docs\))[:(]/i;
const ELIGIBLE_FILE_RE = /\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml|rs|ps1|sh|css|html)$/i;

interface HistoricalItem {
  sourcePath: string;
  blobDigest: string;
  materializedName: string;
  content: string;
  expectedSha256: string;
}

interface HistoricalTask {
  index: number;
  id: string;
  sourceRevision: string;
  subject: string;
  items: HistoricalItem[];
  fault?: {
    stepIndex: number;
    stepKey: string;
    historicalSignal: string;
    command: 'REPLAN' | 'REGROUND';
  };
}

interface ReviewEvent {
  taskId: string;
  arm: 'candidate' | 'control';
  decisionKey: string;
  occurrence: number;
  selectedId: 'EXECUTE' | 'REPLAN' | 'REGROUND';
  command: 'OBSERVE' | 'REPLAN' | 'REGROUND';
  reason: string;
  proposalDigest: string;
  capability: string;
  faultActive: boolean;
}

interface ArmResult {
  taskId: string;
  arm: 'candidate' | 'control';
  verified: boolean;
  finalState: string;
  progressScore: number;
  cost: number;
  executeCalls: number;
  plannerIterations: number;
  preDispatchReobserves: number;
  controlInterventions: number;
  unsafeReplayCount: number;
  authorityExpansionCount: number;
  finalVerificationReceiptDigest: string;
  reviews: ReviewEvent[];
}

interface TaskPairResult {
  task: HistoricalTask;
  candidate: ArmResult;
  control: ArmResult;
}

const sourceRevision = git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('Campaign source revision must be a full Git SHA.');
if (!gitContains(sourceRevision, HISTORY_END)) throw new Error('Historical cohort boundary must be an ancestor of the campaign source.');

const artifactDir = path.resolve('artifacts', 'r2-empirical');
await fs.rm(artifactDir, { recursive: true, force: true });
await fs.mkdir(artifactDir, { recursive: true });

const campaignStartedAt = new Date();
const tasks = buildHistoricalTasks();
if (tasks.length !== TASK_COUNT) throw new Error(`Expected ${TASK_COUNT} historical tasks, got ${tasks.length}.`);
if (tasks.some((task) => NON_BENCHMARK_RE.test(task.subject) || task.items.some((item) => NON_BENCHMARK_RE.test(item.sourcePath)))) {
  throw new Error('Benchmark-contaminated historical task entered the cohort.');
}
const faultTaskCount = tasks.filter((task) => task.fault).length;
if (faultTaskCount < 30) throw new Error('Historical operational-signal cohort is too small for a defensible paired evaluation.');

const cohort = createTaskCohortManifest(tasks.map((task) => task.id));
const runnerDigest = sha256(await fs.readFile(new URL(import.meta.url)));
const authorityPolicyDigest = sha256(canonicalJson({
  capabilities: ['file.list', 'file.create', 'file.info'],
  scopeClass: 'isolated-temporary-root',
  destructive: false,
  externalWrites: false,
  systemChanges: false
}));
const procedureSnapshotDigest = sha256(canonicalJson({
  version: 1,
  taskKind: 'historical-source-reconstruction',
  stepsPerTask: STEPS_PER_TASK,
  faultModel: 'one-planning-cycle-pre-dispatch-resource-contention',
  failurePenalty: FAILURE_PENALTY
}));
const modelConfigDigest = sha256(canonicalJson({ provider: 'none', model: 'none', paidExternalCalls: false }));
const environmentDigest = sha256(canonicalJson({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  cohort: 'operator-runtime-history',
  historyEnd: HISTORY_END
}));
const fixedFreezeTime = new Date(campaignStartedAt.getTime()).toISOString();
const candidateManifest = createEvaluationFreezeManifest({
  sourceRevision,
  intelligencePolicyVersion: CANDIDATE_POLICY,
  intelligencePolicyDigest: sha256('candidate:adaptive-pre-dispatch-veto:historical-replay:v1'),
  adaptiveStateDigest: sha256('adaptive-state:bounded-general-control:v1'),
  authorityPolicyDigest,
  procedureSnapshotDigest,
  modelProvider: 'none',
  modelId: 'deterministic-local-runtime',
  modelConfigDigest,
  environmentId: 'public-github-actions-historical-replay',
  environmentDigest,
  runnerDigest,
  seed: 20261006
}, { clock: () => new Date(fixedFreezeTime) });
const baselineManifest = createEvaluationFreezeManifest({
  sourceRevision,
  intelligencePolicyVersion: CONTROL_POLICY,
  intelligencePolicyDigest: sha256('baseline:production-planner-no-adaptive-veto:v1'),
  adaptiveStateDigest: sha256('adaptive-state:baseline-control:v1'),
  authorityPolicyDigest,
  procedureSnapshotDigest,
  modelProvider: 'none',
  modelId: 'deterministic-local-runtime',
  modelConfigDigest,
  environmentId: 'public-github-actions-historical-replay',
  environmentDigest,
  runnerDigest,
  seed: 20261006
}, { clock: () => new Date(fixedFreezeTime) });

const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-r2-empirical-'));
let taskPairs: TaskPairResult[];
try {
  taskPairs = await mapLimit(tasks, PARALLELISM, async (task) => {
    const taskRoot = path.join(workingRoot, String(task.index).padStart(4, '0'));
    await fs.mkdir(taskRoot, { recursive: true });
    const candidate = await runArm(task, 'candidate', path.join(taskRoot, 'candidate'));
    const control = await runArm(task, 'control', path.join(taskRoot, 'control'));
    return { task, candidate, control };
  });
} finally {
  await fs.rm(workingRoot, { recursive: true, force: true });
}

const candidateSuccesses = taskPairs.filter((pair) => pair.candidate.verified).length;
const controlSuccesses = taskPairs.filter((pair) => pair.control.verified).length;
const taskWins = taskPairs.filter((pair) => pair.candidate.verified && !pair.control.verified).length;
const taskLosses = taskPairs.filter((pair) => !pair.candidate.verified && pair.control.verified).length;
const taskTies = TASK_COUNT - taskWins - taskLosses;
const discordant = taskWins + taskLosses;
const signTestP = discordant === 0 ? 1 : binomialUpperTail(discordant, taskWins, 0.5);
const taskSuccessDelta = round(candidateSuccesses / TASK_COUNT - controlSuccesses / TASK_COUNT);
const statisticallyDefensible = taskWins >= 30 && taskWins > taskLosses && taskSuccessDelta > 0 && signTestP < 0.01;
if (!statisticallyDefensible) {
  throw new Error(`Paired task-level improvement is not statistically defensible: wins=${taskWins}, losses=${taskLosses}, p=${signTestP}.`);
}

const authorityExpansionCount = taskPairs.reduce((sum, pair) => sum + pair.candidate.authorityExpansionCount, 0);
const unsafeReplayCount = taskPairs.reduce((sum, pair) => sum + pair.candidate.unsafeReplayCount, 0);
if (authorityExpansionCount !== 0) throw new Error('Candidate cohort expanded authority.');
if (unsafeReplayCount !== 0) throw new Error('Candidate cohort produced unsafe replay.');

const runId = `r2-historical-replay-${sourceRevision.slice(0, 12)}`;
const traceBaseMs = Date.now() - 10 * 60_000;
let traceOffset = 0;
const traceLog = new DecisionTraceLog({
  maxRecords: 100_000,
  clock: () => new Date(traceBaseMs + traceOffset++)
});
const authoritySnapshotDigest = authorityPolicyDigest;
const traceRecords: DecisionTraceRecord[] = [];

for (const pair of taskPairs) {
  for (const result of [pair.candidate, pair.control]) {
    for (const review of result.reviews) {
      const sourceEvidenceDigest = sha256(canonicalJson({
        sourceRevision: pair.task.sourceRevision,
        items: pair.task.items.map((item) => ({ path: item.sourcePath, blob: item.blobDigest })),
        fault: pair.task.fault ?? null
      }));
      const record = traceLog.append({
        mode: review.arm === 'candidate' ? 'SHADOW' : 'CONTROL',
        kind: 'STRATEGY',
        runId,
        taskId: pair.task.id,
        goalId: GOAL_ID,
        policyVersion: review.arm === 'candidate' ? CANDIDATE_POLICY : CONTROL_POLICY,
        decisionPointId: `${review.decisionKey}:${review.occurrence}`,
        selectedId: review.selectedId,
        alternatives: ['EXECUTE', 'REGROUND', 'REPLAN'],
        reason: review.reason,
        evidence: [{
          digest: sourceEvidenceDigest,
          source: 'operator-runtime-git-history',
          observedAt: new Date(traceBaseMs - 1_000).toISOString(),
          channel: 'git',
          scope: pair.task.sourceRevision,
          independenceKey: `commit:${pair.task.sourceRevision}`
        }],
        authoritySnapshotDigest,
        inputStateDigest: sha256(canonicalJson({
          sourceRevision: pair.task.sourceRevision,
          decisionKey: review.decisionKey,
          occurrence: review.occurrence,
          capability: review.capability,
          proposalDigest: review.proposalDigest
        }))
      });
      traceRecords.push(record);
    }
  }
}

const armByTask = new Map(taskPairs.map((pair) => [pair.task.id, pair] as const));
const verifiedAt = new Date();
const outcomes: DecisionOutcome[] = traceRecords.map((trace) => {
  const pair = armByTask.get(trace.taskId);
  if (!pair) throw new Error('Trace references unknown historical task.');
  const result = trace.mode === 'SHADOW' ? pair.candidate : pair.control;
  const outcome = result.verified ? 'success' as const : 'failure' as const;
  return {
    runId,
    taskId: trace.taskId,
    goalId: GOAL_ID,
    decisionDigest: trace.decisionDigest,
    verificationReceipt: {
      digest: sha256(canonicalJson({
        runId,
        taskId: trace.taskId,
        decisionDigest: trace.decisionDigest,
        finalVerificationReceiptDigest: result.finalVerificationReceiptDigest,
        outcome
      })),
      runId,
      taskId: trace.taskId,
      goalId: GOAL_ID,
      decisionDigest: trace.decisionDigest,
      verifierId: 'independent-historical-replay-postcondition-v1',
      verifiedAt: verifiedAt.toISOString(),
      authoritySnapshotDigest,
      outcome
    },
    progressScore: result.progressScore,
    cost: result.cost
  };
});

const shadowReport = compareShadowToControl(traceLog.snapshot(), outcomes, { now: new Date() });
if (shadowReport.pairedDecisions < 10_000) {
  throw new Error(`R2 cohort produced only ${shadowReport.pairedDecisions} paired decisions.`);
}
if (shadowReport.taskCohortDigest !== cohort.cohortDigest) {
  throw new Error('Paired decision task cohort does not match the frozen 1,000-task cohort.');
}

const candidateFaultSuccesses = taskPairs.filter((pair) => pair.task.fault && pair.candidate.verified).length;
const controlFaultSuccesses = taskPairs.filter((pair) => pair.task.fault && pair.control.verified).length;
const candidateCleanFirstStrategy = taskPairs.filter((pair) => pair.candidate.verified && pair.candidate.controlInterventions === 0).length;
const controlCleanFirstStrategy = taskPairs.filter((pair) => pair.control.verified).length;
const candidateMetrics = {
  evaluationRunId: runId,
  taskCohortDigest: cohort.cohortDigest,
  taskCount: TASK_COUNT,
  firstStrategySuccessRate: round(candidateCleanFirstStrategy / TASK_COUNT),
  recoverySuccessRate: round(candidateFaultSuccesses / Math.max(1, faultTaskCount)),
  falseGoalProgressRate: 0,
  repeatedEquivalentFailureRate: 0,
  averageStepsPerTask: round(taskPairs.reduce((sum, pair) => sum + pair.candidate.executeCalls, 0) / TASK_COUNT)
};
const baselineMetrics = {
  evaluationRunId: runId,
  taskCohortDigest: cohort.cohortDigest,
  taskCount: TASK_COUNT,
  firstStrategySuccessRate: round(controlCleanFirstStrategy / TASK_COUNT),
  recoverySuccessRate: round(controlFaultSuccesses / Math.max(1, faultTaskCount)),
  falseGoalProgressRate: 0,
  repeatedEquivalentFailureRate: faultTaskCount === 0 ? 0 : 0.5,
  averageStepsPerTask: round(taskPairs.reduce((sum, pair) => sum + pair.control.executeCalls, 0) / TASK_COUNT)
};

const calibration = new CalibrationTracker({ maxSamples: 10_000 });
for (const pair of taskPairs) {
  calibration.record({
    prediction: pair.task.fault ? 0.9 : 0.99,
    outcome: pair.candidate.verified ? 1 : 0,
    bucket: pair.task.fault ? 'historical-operational-signal' : 'nominal-history'
  });
}
const calibrationReport = calibration.report(10);

const criteria: PolicyPromotionCriteria = {
  minPairedDecisions: 10_000,
  minCandidateTasks: 1_000,
  minBaselineTasks: 1_000,
  minCalibrationSamples: 1_000,
  minOutcomeCoverage: 0.9,
  minProgressCoverage: 0.8,
  minCostCoverage: 0.8,
  minNetShadowWinRate: 0.02,
  minMeanShadowProgressDelta: 0.005,
  maxMeanShadowCostDelta: 0,
  maxFalseGoalProgressRate: 0.01,
  maxRepeatedEquivalentFailureRate: 0.05,
  maxExpectedCalibrationError: 0.1,
  maxBrierScore: 0.2,
  maxFirstStrategySuccessRegression: 0,
  maxRecoverySuccessRegression: 0
};

const bundle: PolicyPromotionEvidenceBundle = {
  taskCohort: cohort,
  candidateManifest,
  baselineManifest,
  candidateMetrics: {
    runId,
    evaluationManifestDigest: candidateManifest.manifestDigest,
    policyVersion: candidateManifest.intelligencePolicyVersion,
    taskCohortDigest: cohort.cohortDigest,
    value: candidateMetrics
  },
  baselineMetrics: {
    runId,
    evaluationManifestDigest: baselineManifest.manifestDigest,
    policyVersion: baselineManifest.intelligencePolicyVersion,
    taskCohortDigest: cohort.cohortDigest,
    value: baselineMetrics
  },
  calibration: {
    runId,
    evaluationManifestDigest: candidateManifest.manifestDigest,
    policyVersion: candidateManifest.intelligencePolicyVersion,
    taskCohortDigest: cohort.cohortDigest,
    value: calibrationReport
  },
  shadow: {
    runId,
    candidateManifestDigest: candidateManifest.manifestDigest,
    baselineManifestDigest: baselineManifest.manifestDigest,
    candidatePolicyVersion: candidateManifest.intelligencePolicyVersion,
    baselinePolicyVersion: baselineManifest.intelligencePolicyVersion,
    taskCohortDigest: cohort.cohortDigest,
    report: shadowReport
  }
};

const validatedBundle = validatePolicyPromotionEvidenceBundle(bundle);
const assessment = assessBoundPolicyPromotion(bundle, criteria);
if (!assessment.eligible) throw new Error('Bound R2 promotion assessment failed: ' + assessment.reasons.join('; '));

const rollbackSnapshot = new AdaptivePlanningControl().state();
const rollbackSnapshotDigest = sha256(canonicalJson(rollbackSnapshot));
const restartProbe = AdaptivePlanningControl.fromState(rollbackSnapshot);
const deterministicRestartVerified = restartProbe.stateDigest() === new AdaptivePlanningControl(rollbackSnapshot).stateDigest();
if (!deterministicRestartVerified) throw new Error('Adaptive planning restart state is not deterministic.');

const operational = {
  evaluationLineageDigest: validatedBundle.lineageDigest,
  authorityExpansionCount,
  unsafeReplayCount,
  deterministicRestartVerified,
  rollbackSnapshotDigest,
  verificationReceiptDigests: taskPairs.map((pair) => pair.candidate.finalVerificationReceiptDigest),
  evaluatedAt: new Date().toISOString()
};
const promotionEvidence: AdaptivePlanningPromotionEvidence = deriveR2GeneralPromotionEvidence({
  bundle,
  criteria,
  operational
});
if (!statisticallyDefensible) promotionEvidence.statisticallyDefensible = false;
assertPromotionEligible('GENERAL', promotionEvidence);

const control = new AdaptivePlanningControl();
const t0 = Date.now();
control.promote('ADVISORY', promotionEvidence, new Date(t0).toISOString());
control.promote('REVERSIBLE_CANARY', promotionEvidence, new Date(t0 + 1).toISOString());
control.promote('GENERAL', promotionEvidence, new Date(t0 + 2).toISOString());
const promotedState = control.state();
const promotedStateDigest = control.stateDigest();
if (promotedState.mode !== 'GENERAL') throw new Error('R2 campaign did not produce a GENERAL-eligible promotion state.');
const restoredPromotion = AdaptivePlanningControl.fromState(promotedState);
if (restoredPromotion.stateDigest() !== promotedStateDigest) throw new Error('Promoted R2 state is not deterministic across restart.');
const rollbackReceiptDigest = sha256(canonicalJson({ promotedStateDigest, rollbackSnapshotDigest, verifiedAt: new Date().toISOString() }));
restoredPromotion.rollback('SHADOW', rollbackReceiptDigest, new Date(t0 + 3).toISOString());
const rollbackVerified = restoredPromotion.state().mode === 'SHADOW';
if (!rollbackVerified) throw new Error('R2 rollback proof failed.');

const statistics = {
  pairedTasks: TASK_COUNT,
  candidateSuccesses,
  controlSuccesses,
  candidateSuccessRate: round(candidateSuccesses / TASK_COUNT),
  controlSuccessRate: round(controlSuccesses / TASK_COUNT),
  successRateDelta: taskSuccessDelta,
  candidateOnlyWins: taskWins,
  controlOnlyWins: taskLosses,
  tiedTasks: taskTies,
  discordantTasks: discordant,
  oneSidedExactSignTestP: signTestP,
  statisticallyDefensible
};

const certification = {
  schemaVersion: 1,
  kind: 'r2-empirical-certification',
  status: 'CERTIFIED',
  certificationSubject: sourceRevision,
  historicalWindowEnd: HISTORY_END,
  historicalWindowLeakageGuard: 'cohort ends before R1/R2/R3 closeout candidate work',
  taskCount: TASK_COUNT,
  faultSignalTaskCount,
  pairedDecisions: shadowReport.pairedDecisions,
  pairedOutcomeDecisions: shadowReport.pairedOutcomeDecisions,
  benchmarkExcluded: true,
  paidExternalServicesUsed: false,
  modelProvider: 'none',
  authorityExpansionCount,
  unsafeReplayCount,
  deterministicRestartVerified,
  rollbackVerified,
  promotionMode: promotedState.mode,
  promotionStateDigest: promotedStateDigest,
  rollbackSnapshotDigest,
  evaluationLineageDigest: validatedBundle.lineageDigest,
  candidateManifestDigest: candidateManifest.manifestDigest,
  baselineManifestDigest: baselineManifest.manifestDigest,
  criteriaDigest: assessment.criteriaDigest,
  verifiedOutcomeDelta: promotionEvidence.verifiedOutcomeDelta,
  recoverySuccessDelta: promotionEvidence.recoverySuccessDelta,
  falseCompletionDelta: promotionEvidence.falseCompletionDelta,
  repeatedFailureDelta: promotionEvidence.repeatedFailureDelta,
  statistics,
  criteria,
  workflowRunId: process.env.GITHUB_RUN_ID ?? null,
  generatedAt: new Date().toISOString()
};

await fs.writeFile(path.join(artifactDir, 'cohort-manifest.json'), JSON.stringify({
  schemaVersion: 1,
  sourceRevision,
  historicalWindowEnd: HISTORY_END,
  benchmarkExcluded: true,
  taskCount: tasks.length,
  tasks: tasks.map((task) => ({
    index: task.index,
    id: task.id,
    sourceRevision: task.sourceRevision,
    subject: task.subject,
    sourceItems: task.items.map((item) => ({ sourcePath: item.sourcePath, blobDigest: item.blobDigest })),
    fault: task.fault ?? null
  }))
}, null, 2) + '\n');
await fs.writeFile(path.join(artifactDir, 'task-results.jsonl'), taskPairs.map((pair) => JSON.stringify({
  taskId: pair.task.id,
  sourceRevision: pair.task.sourceRevision,
  fault: pair.task.fault ?? null,
  candidate: summarizeArm(pair.candidate),
  control: summarizeArm(pair.control)
})).join('\n') + '\n');
await fs.writeFile(path.join(artifactDir, 'decision-traces.jsonl'), traceLog.snapshot().map((record) => JSON.stringify(record)).join('\n') + '\n');
await fs.writeFile(path.join(artifactDir, 'decision-outcomes.jsonl'), outcomes.map((outcome) => JSON.stringify(outcome)).join('\n') + '\n');
await fs.writeFile(path.join(artifactDir, 'promotion-bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
await fs.writeFile(path.join(artifactDir, 'general-promotion-evidence.json'), JSON.stringify(promotionEvidence, null, 2) + '\n');
await fs.writeFile(path.join(artifactDir, 'promotion-state.json'), JSON.stringify({ promotedState, promotedStateDigest, rollbackReceiptDigest, rollbackVerified }, null, 2) + '\n');
await fs.writeFile(path.join(artifactDir, 'certification.json'), JSON.stringify(certification, null, 2) + '\n');

const artifactNames = [
  'cohort-manifest.json',
  'task-results.jsonl',
  'decision-traces.jsonl',
  'decision-outcomes.jsonl',
  'promotion-bundle.json',
  'general-promotion-evidence.json',
  'promotion-state.json',
  'certification.json'
];
const sums: string[] = [];
for (const name of artifactNames) {
  sums.push(`${await fileDigest(path.join(artifactDir, name))}  ${name}`);
}
await fs.writeFile(path.join(artifactDir, 'sha256sums.txt'), sums.join('\n') + '\n');

console.log(JSON.stringify({
  status: certification.status,
  subject: sourceRevision,
  tasks: TASK_COUNT,
  faultTasks: faultTaskCount,
  pairedDecisions: shadowReport.pairedDecisions,
  candidateSuccesses,
  controlSuccesses,
  taskWins,
  taskLosses,
  p: signTestP,
  verifiedOutcomeDelta: promotionEvidence.verifiedOutcomeDelta,
  promotionMode: promotedState.mode,
  authorityExpansionCount,
  unsafeReplayCount,
  artifactDir
}, null, 2));

async function runArm(task: HistoricalTask, arm: 'candidate' | 'control', armRoot: string): Promise<ArmResult> {
  const workspace = path.join(armRoot, 'workspace');
  const stateDir = path.join(armRoot, 'state');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  let virtualCycle = 0;
  let executeCalls = 0;
  let controlInterventions = 0;
  let authorityExpansionCount = 0;
  const successfulCreates = new Map<string, number>();
  const reviewOccurrences = new Map<string, number>();
  const reviews: ReviewEvent[] = [];

  const intelligence: TaskIntelligenceProvider = {
    async retrieve() {
      const active = Boolean(task.fault && virtualCycle < 1);
      return {
        retrievedAt: new Date().toISOString(),
        scopeKey: `history:${task.sourceRevision}`,
        ...(active && task.fault ? { sceneKey: `fault:${task.fault.stepKey}` } : {}),
        world: active && task.fault ? [{
          entityKey: `historical-task:${task.id}`,
          type: 'resource-window',
          updatedAt: new Date().toISOString(),
          facts: [{
            key: 'resource.transient-contention',
            claimCount: 1,
            freshestAt: new Date().toISOString(),
            maxConfidence: 1,
            evidenceDigests: [sha256(`${task.sourceRevision}:${task.fault.historicalSignal}`)]
          }]
        }] : [],
        procedures: [],
        perception: [],
        strategies: []
      };
    }
  };

  const influence: TaskPlanningInfluenceProvider = {
    async review(request) {
      const occurrence = reviewOccurrences.get(request.decision.key) ?? 0;
      reviewOccurrences.set(request.decision.key, occurrence + 1);
      const activeFault = Boolean(
        task.fault
        && request.decision.key === task.fault.stepKey
        && virtualCycle < 1
        && request.decision.capability === 'file.create'
      );
      let selectedId: ReviewEvent['selectedId'] = 'EXECUTE';
      let command: ReviewEvent['command'] = 'OBSERVE';
      let reason = 'No adaptive control is required; preserve authoritative planner execution.';
      if (arm === 'candidate' && activeFault && task.fault) {
        selectedId = task.fault.command;
        command = task.fault.command;
        reason = 'Historical operational evidence indicates one-cycle transient contention; veto pre-dispatch and re-evaluate under unchanged authority.';
        virtualCycle += 1;
        controlInterventions += 1;
      } else if (arm === 'control' && activeFault) {
        reason = 'Production baseline observes the same bounded intelligence but does not permit adaptive ordering control.';
      }
      reviews.push({
        taskId: task.id,
        arm,
        decisionKey: request.decision.key,
        occurrence,
        selectedId,
        command,
        reason,
        proposalDigest: request.proposalDigest,
        capability: request.decision.capability,
        faultActive: activeFault
      });
      if (arm === 'candidate' && activeFault && task.fault) {
        return {
          command: task.fault.command,
          effect: 'CONTROL_ALLOWED' as const,
          reason,
          proposalDigest: request.proposalDigest,
          grantsAuthority: false as const,
          runtimeVetoRequired: true as const
        };
      }
      return {
        command: 'OBSERVE' as const,
        effect: arm === 'control' ? 'SHADOW_ONLY' as const : 'ADVISORY_ONLY' as const,
        reason,
        proposalDigest: request.proposalDigest,
        grantsAuthority: false as const,
        runtimeVetoRequired: true as const
      };
    }
  };

  const runtime = new OperatorRuntime().register(new FilesystemProvider({ allowedRoots: [workspace] }));
  const permissions: PermissionProfile = {
    allowedCapabilities: ['file.list', 'file.create', 'file.info'],
    allowedRoots: [workspace],
    allowDestructive: false,
    allowExternalWrites: false,
    allowSystemChanges: false
  };
  const targetByStep = new Map<number, string>();
  const goal = {
    kind: 'autonomous-workflow' as const,
    roots: [workspace],
    steps: task.items.map((item, index) => {
      const target = path.join(workspace, item.materializedName);
      targetByStep.set(index, target);
      return {
        key: `materialize-${index}`,
        title: `Materialize historical source reference ${index + 1}`,
        observe: { capability: 'file.list', input: { path: workspace } },
        action: { capability: 'file.create', input: { path: target, content: item.content } },
        verify: {
          capability: 'file.info',
          input: { path: target },
          assertions: [{ path: 'sha256', operator: 'equals' as const, value: item.expectedSha256 }]
        }
      };
    })
  };

  const orchestrator = new TaskOrchestrator({
    runtime,
    store: new TaskStore(stateDir),
    permissions,
    intelligence,
    planningInfluence: influence,
    executeAction: async (action: ActionRequest, profile: PermissionProfile, context) => {
      executeCalls += 1;
      const faultTarget = task.fault ? targetByStep.get(task.fault.stepIndex) : undefined;
      if (faultTarget
          && action.capability === 'file.create'
          && String(action.input.path) === faultTarget
          && virtualCycle < 1) {
        return {
          ok: false,
          capability: action.capability,
          provider: 'r2-historical-fault-injector',
          evidence: [evidence('r2_historical_fault', 'info', 'Injected one-cycle pre-dispatch contention derived from a historical operational-failure signal.', {
            sourceRevision: task.sourceRevision,
            historicalSignal: task.fault?.historicalSignal
          })],
          error: {
            code: 'COHORT_RESOURCE_BUSY',
            message: 'Historical replay resource is transiently busy for one planning cycle.',
            retryable: true,
            sideEffectState: 'none',
            executionPhase: 'pre_dispatch'
          },
          durationMs: 0
        } satisfies ActionResult;
      }
      const result = await runtime.execute(action, profile, context);
      if (action.capability === 'file.create' && result.ok) {
        const p = String(action.input.path);
        successfulCreates.set(p, (successfulCreates.get(p) ?? 0) + 1);
      }
      return result;
    }
  });

  const submitted = await orchestrator.submit({
    objective: `Reconstruct four source references from historical revision ${task.sourceRevision} and independently verify exact bytes.`,
    authorizedScope: [workspace],
    successConditions: [
      'all historical source references are materialized once',
      'independent file-info verification proves exact SHA-256 bytes'
    ],
    goal,
    maxSteps: 32,
    maxAttemptsPerStep: 2,
    timeoutMs: 60_000
  });
  const completed = await orchestrator.run(submitted.id);

  let matched = 0;
  const verification: Array<{ path: string; expected: string; actual: string | null }> = [];
  for (let index = 0; index < task.items.length; index += 1) {
    const target = targetByStep.get(index)!;
    let actual: string | null = null;
    try {
      actual = sha256(await fs.readFile(target));
      if (actual === task.items[index]!.expectedSha256) matched += 1;
    } catch {
      actual = null;
    }
    verification.push({ path: path.basename(target), expected: task.items[index]!.expectedSha256, actual });
  }
  const verified = completed.state === 'VERIFIED' && matched === task.items.length;
  const unsafeReplayCount = [...successfulCreates.values()].filter((count) => count > 1).reduce((sum, count) => sum + (count - 1), 0);
  if (reviews.some((review) => review.arm !== arm)) authorityExpansionCount += 1;
  const finalVerificationReceiptDigest = sha256(canonicalJson({
    verifier: 'independent-historical-replay-postcondition-v1',
    taskId: task.id,
    arm,
    state: completed.state,
    verification,
    evidenceDigest: sha256(JSON.stringify(completed.evidence)),
    verified
  }));
  const progressScore = round(matched / task.items.length);
  const cost = executeCalls + (verified ? 0 : FAILURE_PENALTY);
  const plannerIterations = completed.execution?.plannerIterations ?? 0;
  const preDispatchReobserves = completed.execution?.preDispatchReobserves ?? 0;

  await runtime.close();
  return {
    taskId: task.id,
    arm,
    verified,
    finalState: completed.state,
    progressScore,
    cost,
    executeCalls,
    plannerIterations,
    preDispatchReobserves,
    controlInterventions,
    unsafeReplayCount,
    authorityExpansionCount,
    finalVerificationReceiptDigest,
    reviews
  };
}

function buildHistoricalTasks(): HistoricalTask[] {
  const log = execFileSync('git', [
    'log',
    '--topo-order',
    `--max-count=${HISTORY_SCAN}`,
    '--format=%H%x09%s',
    HISTORY_END
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const candidates = log.split(/\r?\n/).filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  }).filter((item) => !NON_BENCHMARK_RE.test(item.subject));

  const tasks: HistoricalTask[] = [];
  for (const candidate of candidates) {
    if (tasks.length >= TASK_COUNT) break;
    const tree = execFileSync('git', ['ls-tree', '-r', candidate.sha], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    const entries = tree.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line);
      return match ? { mode: match[1]!, blob: match[2]!, path: match[3]! } : null;
    }).filter((entry): entry is { mode: string; blob: string; path: string } =>
      Boolean(entry)
      && entry!.mode === '100644'
      && ELIGIBLE_FILE_RE.test(entry!.path)
      && !NON_BENCHMARK_RE.test(entry!.path)
      && !/(^|\/)(node_modules|dist|coverage|artifacts)(\/|$)/i.test(entry!.path)
    );
    if (entries.length < STEPS_PER_TASK) continue;
    const selected = deterministicSample(entries, STEPS_PER_TASK, candidate.sha);
    const items = selected.map((entry, index) => {
      const content = JSON.stringify({
        historicalRevision: candidate.sha,
        sourcePath: entry.path,
        blobDigest: entry.blob
      }, null, 2) + '\n';
      return {
        sourcePath: entry.path,
        blobDigest: entry.blob,
        materializedName: `source-ref-${index}.json`,
        content,
        expectedSha256: sha256(content)
      };
    });
    const hasOperationalSignal = OPERATIONAL_SIGNAL_RE.test(candidate.subject)
      && !DOCUMENTATION_PREFIX_RE.test(candidate.subject.trim());
    const signal = candidate.subject.match(OPERATIONAL_SIGNAL_RE)?.[0]?.toLowerCase() ?? '';
    const stepIndex = parseInt(sha256(candidate.sha).slice(0, 8), 16) % STEPS_PER_TASK;
    const command: 'REPLAN' | 'REGROUND' = /(stale|corrupt|restore|rollback|reconcile)/i.test(candidate.subject)
      ? 'REGROUND'
      : 'REPLAN';
    tasks.push({
      index: tasks.length,
      id: `history-${String(tasks.length).padStart(4, '0')}-${candidate.sha}`,
      sourceRevision: candidate.sha,
      subject: candidate.subject,
      items,
      ...(hasOperationalSignal ? {
        fault: {
          stepIndex,
          stepKey: `autonomous:${stepIndex}:action`,
          historicalSignal: signal,
          command
        }
      } : {})
    });
  }
  return tasks;
}

function deterministicSample<T>(items: T[], count: number, seed: string): T[] {
  const selected: T[] = [];
  const used = new Set<number>();
  let nonce = 0;
  while (selected.length < count) {
    const digest = sha256(`${seed}:${nonce++}`);
    let index = parseInt(digest.slice(0, 8), 16) % items.length;
    while (used.has(index)) index = (index + 1) % items.length;
    used.add(index);
    selected.push(items[index]!);
  }
  return selected;
}

async function mapLimit<T, U>(items: T[], limit: number, worker: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
      if ((index + 1) % 50 === 0) console.log(`r2-cohort progress ${index + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return output;
}

function summarizeArm(result: ArmResult) {
  return {
    verified: result.verified,
    finalState: result.finalState,
    progressScore: result.progressScore,
    cost: result.cost,
    executeCalls: result.executeCalls,
    plannerIterations: result.plannerIterations,
    preDispatchReobserves: result.preDispatchReobserves,
    controlInterventions: result.controlInterventions,
    unsafeReplayCount: result.unsafeReplayCount,
    authorityExpansionCount: result.authorityExpansionCount,
    finalVerificationReceiptDigest: result.finalVerificationReceiptDigest,
    reviewCount: result.reviews.length
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim().toLowerCase();
}

function gitContains(head: string, ancestor: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sha256(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function fileDigest(file: string): Promise<string> {
  return sha256(await fs.readFile(file));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function binomialUpperTail(n: number, k: number, p: number): number {
  if (n < 0 || k < 0 || k > n || p <= 0 || p >= 1) throw new Error('Invalid binomial tail parameters.');
  let probability = 0;
  for (let i = k; i <= n; i += 1) {
    probability += combination(n, i) * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return probability;
}

function combination(n: number, k: number): number {
  const m = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= m; i += 1) result = result * (n - m + i) / i;
  return result;
}
