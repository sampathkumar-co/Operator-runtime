import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';
import { requireDenseEvaluationArray, requireFrozenEvaluationCases, requireInertEvaluationObject } from './c01-inert-evaluation-input.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash = value => crypto.createHash('sha256').update(typeof value === 'string'
  ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error('C01_FROZEN_LANE_A_INVALID: ' + message); };

function snapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.id !== 'string' || !ID.test(input.id) ||
      typeof input.version !== 'string' || !ID.test(input.version) ||
      !Number.isSafeInteger(input.seed) || input.seed < 0 ||
      typeof input.observation !== 'string' || !input.observation.trim() ||
      Buffer.byteLength(input.observation, 'utf8') > 16 * 1024 ||
      !Array.isArray(input.choices) || input.choices.length < 2 ||
      input.choices.length > 10 || !input.choices.every(choice =>
        choice && typeof choice === 'object' && !Array.isArray(choice) &&
        typeof choice.id === 'string' && ID.test(choice.id) &&
        typeof choice.description === 'string' && choice.description.trim() &&
        Buffer.byteLength(choice.description, 'utf8') < 2048) ||
      new Set(input.choices.map(choice => choice.id)).size !== input.choices.length ||
      typeof input.correctChoiceId !== 'string' ||
      !input.choices.some(choice => choice.id === input.correctChoiceId)) {
    fail('Frozen observation and external scorer key must be bounded and unambiguous.');
  }
  const {correctChoiceId, ...withoutAnswer} = input;
  return {
    prompt: JSON.stringify({
      instruction: 'Choose exactly one permitted decision from the frozen observation. Return JSON only in the form {"choiceId":"..."}; do not perform any action.',
      frozenObservation: withoutAnswer.observation,
      choices: withoutAnswer.choices.map(choice => ({
        id: choice.id, description: choice.description
      }))
    }),
    scorerAnswer: correctChoiceId
  };
}

/**
 * One-shot independent Lane A model-decision evaluation only. It cannot see
 * live Mecord observations, execute providers, inspect account data, or grant
 * authority. The caller explicitly provides a model implementation and a
 * preregistered frozen, nonsecret observation set with hidden expected answer.
 *
 * Returned records are PARTIAL until the independent >50 user-like campaign
 * and provenance certification are completed by the separate acceptance gate.
 */
export async function runFrozenModelLaneA(input) {
  requireInertEvaluationObject(input, fail, 'Lane A configuration');
  requireFrozenEvaluationCases(input.cases, 1, 200, fail, 'model-only cases',
    ['id','version','seed','observation','choices','correctChoiceId']);
  for (const item of input.cases) {
    requireDenseEvaluationArray(item.choices, 2, 10, fail, 'model-only choices');
    for (const choice of item.choices) {
      requireInertEvaluationObject(choice, fail, 'model-only choice', ['id','description']);
    }
  }
  if (!input || typeof input !== 'object' || !SHA.test(input.sourceCommit) ||
      !HASH.test(input.runnerDigest) || !HASH.test(input.modelConfigDigest) ||
      !HASH.test(input.environmentDigest) ||
      typeof input.modelId !== 'string' || !ID.test(input.modelId) ||
      typeof input.generate !== 'function' ||
      !Array.isArray(input.cases) || input.cases.length < 1 ||
      input.cases.length > 200 ||
      !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 16 ||
      input.maxOutputTokens > 4096 ||
      !Number.isSafeInteger(input.maxCostMicrosPerCall) ||
      input.maxCostMicrosPerCall < 0 || input.maxCostMicrosPerCall > 2_000_000 ||
      !Number.isSafeInteger(input.maxLatencyMs) || input.maxLatencyMs < 100 ||
      input.maxLatencyMs > 45000) fail('Explicit bounded model, exact source and frozen cases are required.');
  const scenarios = input.cases.map(entry => ({...entry,
    ...snapshot(entry)}));
  if (new Set(scenarios.map(x => x.id + ':' + x.version + ':' + x.seed)).size !== scenarios.length) {
    fail('Same frozen scenario/seed must not be scored twice.');
  }
  const records = [];
  for (const scenario of scenarios) {
    const start = performance.now();
    let choiceId;
    let costMicros = input.maxCostMicrosPerCall; // unmetered/timeout => reserve full spending ceiling
    let failureStage = 'model';
    const controller = new AbortController();
    let expired = false, timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new Error('C01_LANE_A_MODEL_TIMEOUT'));
      }, input.maxLatencyMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => input.generate({
          prompt: scenario.prompt,
          modelId: input.modelId, signal: controller.signal,
          maxOutputTokens: input.maxOutputTokens
        })),
        timeout
      ]);
      if (expired || controller.signal.aborted) throw Error('Model returned after deadline.');
      if (Number.isSafeInteger(result?.costMicros) &&
          result.costMicros >= 0 && result.costMicros <= input.maxCostMicrosPerCall) {
        costMicros = result.costMicros;
      }
      const text = result?.text;
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024) {
        failureStage = 'schema';
      } else {
        let decoded;
        try { decoded = JSON.parse(text); }
        catch { failureStage = 'schema'; }
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded) &&
            Object.keys(decoded).length === 1 && typeof decoded.choiceId === 'string' &&
            scenario.choices.some(c => c.id === decoded.choiceId)) {
          choiceId = decoded.choiceId;
          failureStage = choiceId === scenario.scorerAnswer ? 'none' : 'model';
        } else { failureStage = 'schema'; }
      }
    } catch {
      failureStage = expired ? 'timing' : 'transport';
    } finally {
      clearTimeout(timer);
    }
    const verified = choiceId === scenario.scorerAnswer;
    records.push({
      id: 'lane_a_' + scenario.id + '_' + scenario.seed,
      lane: 'A', arm: 'model_only',
      sourceCommit: input.sourceCommit,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      seed: scenario.seed,
      model: input.modelId, provider: 'none',
      claimedSuccess: Boolean(choiceId), verifiedSuccess: verified,
      failureStage: verified ? 'none' : failureStage,
      runnerDigest: input.runnerDigest,
      modelConfigDigest: input.modelConfigDigest,
      environmentDigest: input.environmentDigest,
      independentOracleDigest: hash({
        correctChoiceId:scenario.scorerAnswer,
        frozenObservation:scenario.observation,
        choices:scenario.choices
      }),
      resultEvidenceDigest: hash({
        modelChoice:choiceId ?? null, verified, failureStage
      }),
      latencyMs: performance.now() - start,
      costMicros, // unmetered cost pessimistically charged at owner-provided maximum
      humanInterventions: 0,
      unauthorizedEffects: 0
    });
  }
  // This output is deliberately not a complete campaign / paid-cost report.
  const report = buildWave0EvaluationReport({
    sourceCommit: input.sourceCommit, records
  });
  return {
    schemaVersion: 1, sourceCommit: input.sourceCommit,
    status: report.lanes.A.status,
    reportDigest: report.reportDigest,
    independentScorer: 'EXACT_FROZEN_CHOICE',
    costAccounting: 'ACTUAL_WHEN_PROVIDED_ELSE_MAX_RESERVATION',
    sourcePhysicalAcceptance: 'NOT_VERIFIED',
    taskExecution: 'NOT_RUN',
    modelCalls: records.length,
    cases: records.map(record => ({
      id:record.scenarioId, seed:record.seed,
      verifiedSuccess:record.verifiedSuccess,
      failureStage:record.failureStage,
      latencyMs:record.latencyMs,
      resultEvidenceDigest:record.resultEvidenceDigest
    })),
    report
  };
}
