import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const LABEL = /^[a-zA-Z0-9._:-]{1,128}$/;
const STAGES = ['mcpEdge', 'relay', 'journal', 'authority', 'provider', 'verification', 'resultCommit', 'model'];
const quantile = (sorted, fraction) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
const digest = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
function fail(m) { throw new Error('C09_EVIDENCE_MISMATCH: ' + m); }
function requireState(x, m) { if (!x) fail(m); }
function nonnegative(x, m, max = 3_600_000) {
  requireState(typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max, m);
}
function campaign(c, name) {
  requireState(c && typeof c === 'object' && !Array.isArray(c), name + ' campaign missing');
  const campaignKeys = ['sourceCommit', 'fixtureDigest', 'modelConfigDigest', 'controllerDigest',
    'authorizationDigest', 'scorerDigest', 'environmentDigest', 'records'];
  requireState(Object.keys(c).every(key => campaignKeys.includes(key)), name + ' unexpected campaign field');
  for (const key of campaignKeys.filter(key => key !== 'records')) {
    requireState(typeof c[key] === 'string' && (key === 'sourceCommit' ? COMMIT : SHA).test(c[key]), name + '.' + key + ' invalid');
  }
  requireState(Array.isArray(c.records) && c.records.length > 0 && c.records.length <= 20_000,
    name + ' records absent or excessive');
  const rows = new Map();
  for (const item of c.records) {
    requireState(item && typeof item === 'object' && !Array.isArray(item), 'record shape invalid');
    const allowed = ['scenarioId', 'seed', 'arm', 'modelVersion', 'endToEndMs',
      'stageTimingsMs', 'claimedSuccess', 'verifiedSuccess', 'humanInterventions',
      'unauthorizedOperations', 'uncertainReplays', 'costMicros'];
    requireState(Object.keys(item).every(k => allowed.includes(k)), 'raw or unexpected record field');
    for (const k of ['scenarioId', 'arm', 'modelVersion']) requireState(typeof item[k] === 'string' && LABEL.test(item[k]), 'invalid ' + k);
    requireState(Number.isSafeInteger(item.seed) && item.seed >= 0, 'invalid seed');
    const key = [item.scenarioId, item.seed, item.arm, item.modelVersion].join('|');
    requireState(!rows.has(key), 'duplicate journey/seed/arm/model identity');
    nonnegative(item.endToEndMs, 'invalid end-to-end duration');
    requireState(item.stageTimingsMs && typeof item.stageTimingsMs === 'object'
      && !Array.isArray(item.stageTimingsMs) && Object.keys(item.stageTimingsMs).every(k => STAGES.includes(k)),
      'unrecognized stage');
    const stages = Object.values(item.stageTimingsMs);
    requireState(stages.length > 0, 'missing stage breakdown');
    for (const v of stages) nonnegative(v, 'invalid stage timing');
    requireState(stages.reduce((a, b) => a + b, 0) <= item.endToEndMs + 1,
      'stage totals exceed end-to-end duration');
    requireState(typeof item.claimedSuccess === 'boolean' && typeof item.verifiedSuccess === 'boolean',
      'claimed and verified outcomes must be separate booleans');
    for (const k of ['humanInterventions', 'unauthorizedOperations', 'uncertainReplays', 'costMicros']) {
      requireState(Number.isSafeInteger(item[k]) && item[k] >= 0 && item[k] <= 1e12, 'invalid counter: ' + k);
    }
    rows.set(key, item);
  }
  return rows;
}
function summarize(records) {
  const latency = records.map(x => x.endToEndMs).sort((a, b) => a - b);
  const stageMs = Object.fromEntries(STAGES.map(stage => {
    const nums = records.map(x => x.stageTimingsMs[stage] ?? 0).sort((a, b) => a - b);
    return [stage, { p50: quantile(nums, .5), p95: quantile(nums, .95), p99: quantile(nums, .99) }];
  }));
  const sum = key => records.reduce((total, item) => {
    const next = total + item[key];
    requireState(Number.isSafeInteger(next), 'aggregate counter overflow: ' + key);
    return next;
  }, 0);
  return {
    attempts: records.length, p50Ms: quantile(latency, .5), p95Ms: quantile(latency, .95),
    p99Ms: quantile(latency, .99), verifiedSuccesses: records.filter(x => x.verifiedSuccess).length,
    falseCompletionCount: records.filter(x => x.claimedSuccess && !x.verifiedSuccess).length,
    unauthorizedOperations: sum('unauthorizedOperations'),
    uncertainReplays: sum('uncertainReplays'),
    humanInterventions: sum('humanInterventions'), costMicros: sum('costMicros'), stageMs
  };
}
/** Comparison requires identical frozen scenarios/seeds/model config/authority/environment,
 * but the outcome records are still unauthenticated input until signed independent proof.
 */
export function compareMatchedPerformance({ baseline, candidate }) {
  const oldRows = campaign(baseline, 'baseline');
  const newRows = campaign(candidate, 'candidate');
  for (const key of ['fixtureDigest', 'modelConfigDigest', 'controllerDigest', 'authorizationDigest', 'scorerDigest', 'environmentDigest']) {
    requireState(baseline[key] === candidate[key], 'not comparable: ' + key);
  }
  requireState(oldRows.size === newRows.size &&
    [...oldRows.keys()].every(k => newRows.has(k)), 'scenario/seed/model identity mismatch');
  const keys = [...oldRows.keys()].sort();
  const a = summarize(keys.map(k => oldRows.get(k)));
  const b = summarize(keys.map(k => newRows.get(k)));
  // Aggregate success can hide a swapped failure: candidate succeeds at an
  // easier task while regressing a previously verified user journey. Require
  // no loss of the independent scorer's result for *each* matched identity.
  const noLostVerifiedJourneys = keys.every(key =>
    oldRows.get(key).verifiedSuccess !== true || newRows.get(key).verifiedSuccess === true
  );
  // Aggregate counters can also hide a false-success or intervention swap
  // between two different journeys. Regressions belong to the exact frozen
  // scenario/seed/model identity, not merely to the campaign totals.
  const introducedFalseCompletionJourneys = keys.filter(key => {
    const before = oldRows.get(key);
    const after = newRows.get(key);
    return after.claimedSuccess && !after.verifiedSuccess &&
      !(before.claimedSuccess && !before.verifiedSuccess);
  }).length;
  const introducedHumanInterventionJourneys = keys.filter(key =>
    newRows.get(key).humanInterventions > oldRows.get(key).humanInterventions
  ).length;
  const reasons = [
    ...(b.p50Ms > a.p50Ms ? ['P50_LATENCY_REGRESSION'] : []),
    ...(b.p95Ms > a.p95Ms ? ['P95_LATENCY_REGRESSION'] : []),
    ...(b.p99Ms > a.p99Ms ? ['P99_LATENCY_REGRESSION'] : []),
    ...(!noLostVerifiedJourneys ? ['LOST_VERIFIED_JOURNEY'] : []),
    ...(b.verifiedSuccesses < a.verifiedSuccesses ? ['VERIFIED_COMPLETION_REGRESSION'] : []),
    ...(b.falseCompletionCount > a.falseCompletionCount ? ['FALSE_COMPLETION_TOTAL_INCREASE'] : []),
    ...(introducedFalseCompletionJourneys ? ['NEW_FALSE_COMPLETION_JOURNEY'] : []),
    ...(b.humanInterventions > a.humanInterventions ? ['HUMAN_INTERVENTION_TOTAL_INCREASE'] : []),
    ...(introducedHumanInterventionJourneys ? ['NEW_HUMAN_INTERVENTION_JOURNEY'] : []),
    ...(b.costMicros > a.costMicros ? ['COST_INCREASE'] : []),
    ...(b.unauthorizedOperations ? ['UNAUTHORIZED_OPERATION'] : []),
    ...(b.uncertainReplays ? ['UNCERTAIN_REPLAY'] : [])
  ];
  const candidateNotWorse = reasons.length === 0;
  return {
    schemaVersion: 1,
    baselineSourceCommit: baseline.sourceCommit, candidateSourceCommit: candidate.sourceCommit,
    matchedRecordCount: keys.length, comparisonKeyDigest: digest(keys),
    baseline: a, candidate: b, observedCandidateNotWorse: candidateNotWorse,
    regressionDiagnostics: {
      introducedFalseCompletionJourneys,
      introducedHumanInterventionJourneys,
      reasons
    },
    sourceTruth: 'SELF_REPORTED_INPUT_NOT_AUTHENTICATED',
    physicalAcceptance: 'NOT_VERIFIED', modelAndEnvironmentTruth: 'DECLARED_NOT_INDEPENDENTLY_ATTESTED',
    releaseAcceptance: 'NOT_ACCEPTED',
    note: 'A positive comparison is diagnostic only. Independent signed oracle evidence and real physical workload acceptance are separate gates.'
  };
}
const MAX_CAMPAIGN_BYTES = 32 * 1024 * 1024;
async function readCampaignFile(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    requireState(stat.isFile() && stat.size > 0 && stat.size <= MAX_CAMPAIGN_BYTES,
      'input campaign file size invalid');
    const contents = await handle.readFile('utf8');
    requireState(Buffer.byteLength(contents, 'utf8') <= MAX_CAMPAIGN_BYTES,
      'input campaign file size invalid');
    return JSON.parse(contents);
  } finally {
    await handle.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/c09-compare-performance.mjs baseline.json candidate.json');
  const baseline = await readCampaignFile(process.argv[2]);
  const candidate = await readCampaignFile(process.argv[3]);
  process.stdout.write(JSON.stringify(compareMatchedPerformance({ baseline, candidate }), null, 2) + '\n');
}
