import crypto from 'node:crypto';

const LANES = Object.freeze(['A', 'B', 'C']);
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DOMAIN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const FAILURE_STAGES = new Set([
  'model', 'schema', 'grounding', 'action', 'policy',
  'transport', 'verifier', 'timing', 'uncertain_side_effect', 'none'
]);
const reasons = {
  A: 'No independently scored model-only decisions on frozen observations.',
  B: 'No source-matched fixed-action execution campaign with an independent state oracle.',
  C: 'No paired, same-model Mecord/direct-tool user-task campaign with independent outcomes.'
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(message) { throw new Error(`WAVE0_EVALUATION_INVALID: ${message}`); }
function exactString(value, label, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || !DOMAIN.test(value)) fail(`${label} invalid`);
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !SHA.test(value)) fail(`${label} must be an immutable sha256`);
  return value;
}
function nonnegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} invalid`);
  return value;
}
export function validateWave0Record(record, sourceCommit) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('record must be an object');
  const lane = record.lane;
  if (!LANES.includes(lane)) fail('unknown lane');
  if (record.sourceCommit !== sourceCommit) fail('record source commit does not match the frozen manifest');
  const arm = record.arm;
  if ((lane === 'A' && arm !== 'model_only') ||
      (lane === 'B' && arm !== 'mecord_scripted') ||
      (lane === 'C' && arm !== 'mecord' && arm !== 'direct')) fail('arm does not belong to lane');
  if (typeof record.claimedSuccess !== 'boolean' || typeof record.verifiedSuccess !== 'boolean') fail('completion claims require distinct booleans');
  if (record.failureStage === undefined || !FAILURE_STAGES.has(record.failureStage)) fail('failure attribution missing');
  if (!Number.isSafeInteger(record.seed) || record.seed < 0) fail('seed invalid');
  for (const label of ['id', 'scenarioId', 'scenarioVersion', 'model', 'provider']) exactString(record[label], label);
  for (const label of ['runnerDigest', 'modelConfigDigest', 'environmentDigest',
    'independentOracleDigest', 'resultEvidenceDigest']) digest(record[label], label);
  nonnegativeNumber(record.latencyMs, 'latencyMs');
  nonnegativeNumber(record.costMicros, 'costMicros');
  if (!Number.isSafeInteger(record.humanInterventions) || record.humanInterventions < 0) fail('humanInterventions invalid');
  if (!Number.isSafeInteger(record.unauthorizedEffects) || record.unauthorizedEffects < 0) fail('unauthorizedEffects invalid');
  if (lane === 'B' && (record.model !== 'scripted' || record.provider === 'none')) fail('Lane B must be model-independent scripted runtime execution');
  if (lane === 'A' && record.provider !== 'none') fail('Lane A must not dispatch through a provider');
  if (lane === 'C' && (record.model === 'scripted' || record.provider === 'none')) fail('Lane C requires a specific real model and tool provider');
  return record;
}
function percentile(numbers, p) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function summarize(records) {
  if (!records.length) return null;
  return {
    runs: records.length, verifiedSuccesses: records.filter(x => x.verifiedSuccess).length,
    claimedSuccesses: records.filter(x => x.claimedSuccess).length,
    falseCompletions: records.filter(x => x.claimedSuccess && !x.verifiedSuccess).length,
    unsafeEffects: records.reduce((total, x) => total + x.unauthorizedEffects, 0),
    humanInterventions: records.reduce((total, x) => total + x.humanInterventions, 0),
    verifiedCompletionRate: records.filter(x => x.verifiedSuccess).length / records.length,
    p50LatencyMs: percentile(records.map(x => x.latencyMs), 0.5),
    p95LatencyMs: percentile(records.map(x => x.latencyMs), 0.95),
    modelAndToolCostMicros: records.reduce((total, x) => total + x.costMicros, 0),
    failuresByStage: Object.fromEntries([...FAILURE_STAGES].sort().map(stage =>
      [stage, records.filter(x => x.failureStage === stage).length]))
  };
}
function identity(run) {
  return JSON.stringify([run.scenarioId, run.scenarioVersion, run.seed,
    run.runnerDigest, run.model, run.modelConfigDigest, run.environmentDigest,
    run.independentOracleDigest]);
}
export function buildWave0EvaluationReport({ sourceCommit, records = [], preregistered = null }) {
  if (typeof sourceCommit !== 'string' || !COMMIT.test(sourceCommit)) fail('sourceCommit must be exact 40-digit git SHA');
  if (!Array.isArray(records) || records.length > 10000) fail('runs must be a bounded array');
  const valid = records.map(x => validateWave0Record(x, sourceCommit));
  const ids = new Set();
  for (const record of valid) {
    if (ids.has(record.id)) fail('duplicate run ID');
    ids.add(record.id);
  }
  if (preregistered !== null) {
    if (!preregistered || !SHA.test(preregistered.suiteDigest ?? '') ||
      !Array.isArray(preregistered.expectedScenarioIds) || preregistered.expectedScenarioIds.length < 50 ||
      new Set(preregistered.expectedScenarioIds).size !== preregistered.expectedScenarioIds.length) {
      fail('complete campaign requires preregistered suite digest and >=50 unique scenarios');
    }
  }
  const expectedIds = preregistered?.expectedScenarioIds ?? [];
  const laneSummaries = {};
  for (const lane of LANES) {
    const inLane = valid.filter(x => x.lane === lane);
    const expected = new Set(expectedIds);
    const hasFullSuite = preregistered !== null &&
      expectedIds.every(id => inLane.some(x => x.scenarioId === id)) &&
      inLane.every(x => expected.has(x.scenarioId));
    let paired = false;
    if (lane === 'C' && inLane.length) {
      const left = new Map(), right = new Map();
      for (const run of inLane) {
        const key = identity(run);
        const target = run.arm === 'mecord' ? left : right;
        if (target.has(key)) fail('duplicate Lane C pairing identity');
        target.set(key, run);
      }
      if (left.size !== right.size || [...left.keys()].some(key => !right.has(key))) fail('Lane C Mecord/direct cohorts are not paired');
      paired = left.size > 0;
    }
    if (lane !== 'C') {
      const identities = new Set();
      for (const run of inLane) {
        const key = identity(run);
        if (identities.has(key)) fail('duplicate evaluation identity');
        identities.add(key);
      }
    }
    const sourceEvidence = inLane.length === 0 ? null : lane === 'C'
      ? { mecord: summarize(inLane.filter(x => x.arm === 'mecord')),
          direct: summarize(inLane.filter(x => x.arm === 'direct')) }
      : summarize(inLane);
    laneSummaries[lane] = {
      status: inLane.length === 0 ? 'NOT_RUN'
        : hasFullSuite && (lane !== 'C' || paired) ? 'REPORTED_FULL_COVERAGE_UNVERIFIED' : 'PARTIAL',
      physicalAcceptance: 'NOT_VERIFIED',
      reason: inLane.length === 0 ? reasons[lane] : hasFullSuite
        ? 'Recorded suite coverage exists; provenance and physical release qualification remain independent.'
        : 'Partial evidence only; do not infer a completed 50-workflow campaign.',
      evidence: sourceEvidence
    };
  }
  const report = { schemaVersion: 1, sourceCommit,
    suite: preregistered ? { digest: preregistered.suiteDigest, scenarios: expectedIds.length } : { status: 'NOT_REGISTERED' },
    lanes: laneSummaries, full125MiniWob: 'NOT_RUN',
    sourcePhysicalAcceptance: 'NOT_VERIFIED',
    releaseAcceptance: 'NOT_ACCEPTED',
    note: 'Only independent real-world scorers and exact source-matched physical evidence may close release gates.' };
  return { ...report, reportDigest: sha256(JSON.stringify(report)) };
}
