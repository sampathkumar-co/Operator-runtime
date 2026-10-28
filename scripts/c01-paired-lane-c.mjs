import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';
import { requireFrozenEvaluationCases, requireInertEvaluationObject } from './c01-inert-evaluation-input.mjs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STAGES = new Set(['model','schema','grounding','action','policy',
  'transport','verifier','timing','uncertain_side_effect','unattributed']);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function deny(reason) { throw new Error('C01_LANE_C_PAIR_INVALID: ' + reason); }
function boundedString(x, max) {
  return typeof x === 'string' && x.trim().length > 0 &&
    x.length <= max && Buffer.byteLength(x, 'utf8') <= max && !/[\0]/.test(x);
}
function integer(x, min, max) {
  return Number.isSafeInteger(x) && x >= min && x <= max;
}
function validCase(c) {
  return c && typeof c === 'object' && !Array.isArray(c) &&
    typeof c.id === 'string' && typeof c.version === 'string' &&
    ID.test(c.id) && ID.test(c.version) &&
    integer(c.seed, 0, 1_000_000) &&
    boundedString(c.objective, 2048) &&
    boundedString(c.prompt, 16 * 1024) &&
    DIGEST.test(c.initialStateDigest ?? '') &&
    DIGEST.test(c.independentOracleDigest ?? '');
}
function validInput(x) {
  return x && typeof x === 'object' && !Array.isArray(x) &&
    typeof x.sourceCommit === 'string' && SHA.test(x.sourceCommit) &&
    typeof x.runnerDigest === 'string' && DIGEST.test(x.runnerDigest) &&
    typeof x.modelConfigDigest === 'string' && DIGEST.test(x.modelConfigDigest) &&
    typeof x.environmentDigest === 'string' && DIGEST.test(x.environmentDigest) &&
    typeof x.modelId === 'string' && ID.test(x.modelId) &&
    Array.isArray(x.cases) && x.cases.length >= 1 && x.cases.length <= 200 &&
    x.cases.every(validCase) &&
    integer(x.maxSteps, 1, 300) &&
    integer(x.maxOutputTokens, 64, 4096) &&
    integer(x.maxCostMicrosPerArm, 0, 2_000_000) &&
    integer(x.deadlineMs, 100, 120_000) &&
    typeof x.resetFixture === 'function' &&
    typeof x.runArm === 'function' &&
    typeof x.verifyIndependentOutcome === 'function';
}

/**
 * Source-only comparative evaluation of EXACT matched runtime and direct-tool
 * arms. The harness is deliberately unable to dispatch anything by itself.
 *
 * resetFixture, runArm and verifyIndependentOutcome MUST be separately trusted
 * evaluator callbacks. Their self-attestation is not independent signed proof:
 * even 50+ entries never qualify physical or release acceptance.
 */
// Fixture reset and independent oracle are caller-defined asynchronous
// operations too. Their execution time must be bounded separately from
// model/tool dispatch. A timeout or rejection quarantines the whole pair.
// Abort is advisory: the caller must independently prove quiescence before any
// retry, even if a misbehaving callback ignores its signal.
async function boundedExternalPhase(name, deadlineMs, invoke) {
  const controller = new AbortController();
  let expired = false, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(new Error('C01_LANE_C_EXTERNAL_PHASE_TIMEOUT'));
    }, deadlineMs);
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)), timeout
    ]);
    if (expired || controller.signal.aborted) deny(name + '_TIMEOUT_UNKNOWN_EFFECT: phase did not quiesce.');
    return value;
  } catch {
    deny(name + (expired ? '_TIMEOUT_UNKNOWN_EFFECT' : '_FAILED_UNKNOWN_EFFECT') +
      ': independent reconciliation required before any second arm.');
  } finally {
    clearTimeout(timer);
  }
}

export async function runPairedLaneC(input) {
  requireInertEvaluationObject(input, deny, 'Lane C configuration');
  // Fail before reading any callback getter or resetting even the first arm.
  if (Object.getOwnPropertyDescriptor(input, 'cases')?.value !== undefined) {
    requireFrozenEvaluationCases(Object.getOwnPropertyDescriptor(input, 'cases').value,
      1, 200, deny, 'paired scenarios',
      ['id','version','seed','objective','prompt','initialStateDigest','independentOracleDigest']);
  }
  if (!validInput(input)) deny('A source-pinned model, fixed cases and three trusted evaluator callbacks are required.');
  const unique = new Set();
  for (const c of input.cases) {
    const key = JSON.stringify([c.id,c.version,c.seed]);
    if (unique.has(key)) deny('Duplicate scenario/version/seed is not a matched independent campaign.');
    unique.add(key);
  }
  const records = [];
  const pairs = [];
  for (const c of input.cases) {
    const promptDigest = hash(c.prompt);
    const budget = Object.freeze({
      maxSteps: input.maxSteps,
      maxOutputTokens: input.maxOutputTokens,
      maxCostMicros: input.maxCostMicrosPerArm,
      deadlineMs: input.deadlineMs
    });
    const budgetDigest = hash(JSON.stringify(budget));
    const ordering = c.seed % 2 === 0 ? ['mecord','direct'] : ['direct','mecord'];
    const completed = {};
    const sanitized = Object.freeze({
      id:c.id, version:c.version, seed:c.seed,
      objective:c.objective, prompt:c.prompt
    });
    for (const arm of ordering) {
      const initial = await boundedExternalPhase('RESET', input.deadlineMs,
        signal => input.resetFixture({
          arm, scenarioId:c.id, scenarioVersion:c.version, seed:c.seed, signal
        }));
      if (!initial || initial.initialStateDigest !== c.initialStateDigest ||
          !DIGEST.test(initial.initialStateDigest)) {
        deny('Fixture reset did not independently reestablish the identical pre-action state.');
      }
      const started = performance.now();
      const controller = new AbortController();
      let timer, expired = false;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          reject(new Error('C01_LANE_C_ARM_TIMEOUT'));
        }, input.deadlineMs);
      });
      let execution;
      try {
        execution = await Promise.race([
          Promise.resolve().then(() => input.runArm({
            arm, scenario:sanitized, modelId:input.modelId,
            modelConfigDigest:input.modelConfigDigest,
            promptDigest,
            budget,
            signal:controller.signal
          })),
          deadline
        ]);
      } catch (error) {
        // An incomplete/late side effect must not silently contaminate a
        // subsequent reset or arm. Stop the comparison: no false clean score.
        const reason = expired ? 'TIMEOUT_UNKNOWN_EFFECT' : 'EXECUTION_UNKNOWN_EFFECT';
        deny(reason + ': paired task execution requires manual quiescence and independent reconciliation.');
      } finally {
        clearTimeout(timer);
      }
      if (expired || controller.signal.aborted) {
        deny('Late model or tool result cannot satisfy a timed-out arm.');
      }
      if (!execution || typeof execution !== 'object' ||
          typeof execution.claimedSuccess !== 'boolean' ||
          execution.observedPromptDigest !== promptDigest ||
          execution.observedModelConfigDigest !== input.modelConfigDigest ||
          !integer(execution.humanInterventions,0,1000) ||
          (execution.costMicros !== undefined &&
            !integer(execution.costMicros, 0, input.maxCostMicrosPerArm))) {
        deny('Runner evidence failed exact model, prompt, cost or outcome contract.');
      }
      // Runner claims never count as verification. The independent observer
      // may inspect external server or authorized machine post-state.
      const oracle = await boundedExternalPhase('ORACLE', input.deadlineMs,
        signal => input.verifyIndependentOutcome({
          arm, scenarioId:c.id, scenarioVersion:c.version,
          seed:c.seed, expectedOracleDigest:c.independentOracleDigest,
          executionEvidence:execution.evidence ?? null, signal
        }));
      if (!oracle || typeof oracle !== 'object' ||
          typeof oracle.verifiedSuccess !== 'boolean' ||
          oracle.independentOracleDigest !== c.independentOracleDigest ||
          !DIGEST.test(oracle.resultEvidenceDigest ?? '') ||
          !integer(oracle.unauthorizedEffects, 0, 1_000_000) ||
          (oracle.verifiedSuccess
            ? oracle.failureStage !== 'none'
            : !STAGES.has(oracle.failureStage))) {
        deny('Fresh external outcome/side-effect oracle proof is absent, stale or malformed.');
      }
      const record = {
        id: 'lane_c_' + hash(JSON.stringify([c.id,c.version,c.seed,arm])).slice(0,32),
        lane:'C',arm, sourceCommit:input.sourceCommit,
        scenarioId:c.id,scenarioVersion:c.version,seed:c.seed,
        model:input.modelId,
        provider:arm === 'mecord' ? 'mecord' : 'direct-tools',
        runnerDigest:input.runnerDigest, modelConfigDigest:input.modelConfigDigest,
        environmentDigest:input.environmentDigest,
        promptDigest, budgetDigest,
        independentOracleDigest:c.independentOracleDigest,
        resultEvidenceDigest:oracle.resultEvidenceDigest,
        claimedSuccess:execution.claimedSuccess,
        verifiedSuccess:oracle.verifiedSuccess,
        failureStage:oracle.failureStage,
        latencyMs:performance.now() - started,
        costMicros: execution.costMicros ?? input.maxCostMicrosPerArm,
        humanInterventions:execution.humanInterventions,
        unauthorizedEffects:oracle.unauthorizedEffects
      };
      completed[arm] = record;
    }
    // Only retain a pair after *both* arms have returned independent results.
    records.push(completed.mecord, completed.direct);
    pairs.push({
      scenarioId:c.id,scenarioVersion:c.version,seed:c.seed,
      mecordVerified:completed.mecord.verifiedSuccess,
      directVerified:completed.direct.verifiedSuccess,
      mecordClaimed:completed.mecord.claimedSuccess,
      directClaimed:completed.direct.claimedSuccess
    });
  }
  const report=buildWave0EvaluationReport({sourceCommit:input.sourceCommit,records});
  return {
    schemaVersion:1,
    sourceCommit:input.sourceCommit,
    status:report.lanes.C.status,
    exactPairCount:pairs.length,
    pairs,
    reportDigest:report.reportDigest,
    claimedPhysicalAcceptance:'NOT_VERIFIED',
    modelProviderCertification:'CALLER_ATTESTED_ONLY',
    actualModelCalls:'UNVERIFIED_BY_THIS_HARNESS',
    independentOracleProvenance:'CALLER_ATTESTED_ONLY',
    releaseAcceptance:report.releaseAcceptance,
    report
  };
}
