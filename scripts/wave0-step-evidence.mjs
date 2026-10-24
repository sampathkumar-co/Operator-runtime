import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const LANES = new Set(['A', 'B', 'C']);
const ARMS = Object.freeze({ A: ['model_only'], B: ['mecord_scripted'], C: ['mecord', 'direct'] });
const RISK = new Set(['read', 'write', 'external', 'system', 'destructive']);
const SIDE_EFFECT = new Set(['none', 'known', 'uncertain']);
const PHASE = new Set(['observe', 'decision', 'authorize', 'dispatch', 'result', 'verify', 'reconcile', 'stop']);
const VERDICT = new Set(['pass', 'fail', 'unknown']);
const MAX_STEPS = 20000;
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function invalid(message) { throw new Error('WAVE0_TRACE_INVALID: ' + message); }
function token(x, label) {
  if (typeof x !== 'string' || !TOKEN.test(x)) invalid(label + ' is not a bounded identity');
  return x;
}
function digest(x, label) {
  if (typeof x !== 'string' || !DIGEST.test(x)) invalid(label + ' must be a content digest');
  return x;
}
function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label + ' must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(label + ' contains disallowed raw field ' + key);
}
function natural(x, label) {
  if (!Number.isSafeInteger(x) || x < 0) invalid(label + ' must be nonnegative integer');
  return x;
}
function phaseKey(item) { return item.runId + ':' + item.arm; }

/**
 * A sanitized immutable step transcript is a record of externally supplied digest identities,
 * not evidence that a model, provider or independent scorer actually ran. Scorer outcomes are
 * retained as attributed claims; only separately authenticated external artifacts can certify them.
 */
export function buildWave0TraceBundle({ sourceCommit, controllerId, recorderId, steps, scorecards = [] }) {
  if (typeof sourceCommit !== 'string' || !COMMIT.test(sourceCommit)) invalid('source commit is not exact');
  token(controllerId, 'controllerId');
  token(recorderId, 'recorderId');
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) invalid('bounded nonempty steps required');
  if (!Array.isArray(scorecards) || scorecards.length > MAX_STEPS) invalid('bounded scorecards required');
  const allowedStep = ['runId', 'lane', 'arm', 'scenarioId', 'seed', 'step', 'attempt', 'phase',
    'actionId', 'capability', 'risk', 'sideEffectState', 'observationDigest', 'actionDigest',
    'resultDigest', 'timestampMs'];
  const sanitized = [];
  const seen = new Set();
  const perRun = new Map();
  const perAction = new Map();
  for (const row of steps) {
    exactKeys(row, allowedStep, 'step');
    const runId = token(row.runId, 'runId');
    const lane = row.lane;
    if (!LANES.has(lane) || !ARMS[lane].includes(row.arm)) invalid('lane or arm invalid');
    token(row.scenarioId, 'scenarioId');
    const seed = natural(row.seed, 'seed');
    const step = natural(row.step, 'step');
    const attempt = natural(row.attempt, 'attempt');
    if (!PHASE.has(row.phase)) invalid('phase invalid');
    token(row.actionId, 'actionId');
    token(row.capability, 'capability');
    if (!RISK.has(row.risk) || !SIDE_EFFECT.has(row.sideEffectState)) invalid('risk or side effect invalid');
    for (const key of ['observationDigest', 'actionDigest', 'resultDigest']) digest(row[key], key);
    const timestampMs = natural(row.timestampMs, 'timestampMs');
    if (lane === 'A' && row.phase === 'dispatch') invalid('Lane A must not dispatch an action');
    if (lane === 'A' && row.sideEffectState !== 'none') invalid('Lane A must never claim external side effects');
    if (row.risk === 'read' && row.sideEffectState !== 'none') invalid('read-only step has side effect');
    const key = [runId, row.arm, step, attempt, row.phase].join(':');
    if (seen.has(key)) invalid('duplicate step event identity');
    seen.add(key);
    const rKey = phaseKey(row);
    const previous = perRun.get(rKey);
    if (previous) {
      if (previous.scenarioId !== row.scenarioId || previous.seed !== seed || previous.lane !== lane) {
        invalid('run identity changed during transcript');
      }
      if (step < previous.step || (step === previous.step && attempt < previous.attempt) ||
        timestampMs < previous.timestampMs) invalid('non-monotonic step or timestamp');
      if (step > previous.step + 1) invalid('missing step number');
    } else if (step !== 0 || attempt !== 0) {
      invalid('a transcript must begin at step zero, attempt zero');
    }
    perRun.set(rKey, { scenarioId: row.scenarioId, seed, lane, step, attempt, timestampMs });
    const aKey = [rKey, row.actionId].join(':');
    const earlier = perAction.get(aKey);
    if (earlier) {
      if (earlier.actionDigest !== row.actionDigest || earlier.risk !== row.risk) {
        invalid('action identity reused for a changed action');
      }
      if (attempt > earlier.attempt) {
        if (row.risk !== 'read' && earlier.maximumSideEffectState !== 'none') {
          invalid('mutating action retried after known or uncertain effects');
        }
      }
    }
    const rank = { none: 0, known: 1, uncertain: 2 };
    const previousMaximum = earlier?.maximumSideEffectState ?? 'none';
    const maximumSideEffectState = rank[row.sideEffectState] > rank[previousMaximum]
      ? row.sideEffectState : previousMaximum;
    perAction.set(aKey, { actionDigest: row.actionDigest, risk: row.risk, attempt,
      maximumSideEffectState });
    sanitized.push({ runId, lane, arm: row.arm, scenarioId: row.scenarioId, seed,
      step, attempt, phase: row.phase, actionId: row.actionId, capability: row.capability,
      risk: row.risk, sideEffectState: row.sideEffectState,
      observationDigest: row.observationDigest, actionDigest: row.actionDigest,
      resultDigest: row.resultDigest, timestampMs });
  }
  const allowedScore = ['runId', 'arm', 'scenarioId', 'scorerId', 'verdict', 'oracleDigest',
    'outcomeEvidenceDigest', 'scorecardDigest'];
  const retained = [];
  const scored = new Set();
  for (const score of scorecards) {
    exactKeys(score, allowedScore, 'scorecard');
    const runId = token(score.runId, 'scorecard.runId');
    token(score.arm, 'scorecard.arm');
    token(score.scenarioId, 'scorecard.scenarioId');
    token(score.scorerId, 'scorecard.scorerId');
    if (score.scorerId === controllerId || score.scorerId === recorderId) {
      invalid('scorer is not separate from the controller/recorder');
    }
    if (!VERDICT.has(score.verdict)) invalid('scorer verdict invalid');
    digest(score.oracleDigest, 'oracleDigest');
    digest(score.outcomeEvidenceDigest, 'outcomeEvidenceDigest');
    digest(score.scorecardDigest, 'scorecardDigest');
    const run = perRun.get(runId + ':' + score.arm);
    if (!run || run.scenarioId !== score.scenarioId) invalid('scorecard has no matching trace');
    const key = runId + ':' + score.arm;
    if (scored.has(key)) invalid('duplicate scorer result for one execution');
    scored.add(key);
    retained.push({ runId, arm: score.arm, scenarioId: score.scenarioId,
      scorerId: score.scorerId, verdict: score.verdict, oracleDigest: score.oracleDigest,
      outcomeEvidenceDigest: score.outcomeEvidenceDigest, scorecardDigest: score.scorecardDigest });
  }
  const traceJsonl = sanitized.map(x => JSON.stringify(x)).join('\n') + '\n';
  const scorecardJsonl = retained.map(x => JSON.stringify(x)).join('\n') + (retained.length ? '\n' : '');
  const manifest = {
    schemaVersion: 1, sourceCommit, controllerId, recorderId,
    eventCount: sanitized.length, executionCount: perRun.size, scorecardCount: retained.length,
    traceSha256: sha256(traceJsonl), scorecardSha256: sha256(scorecardJsonl),
    unmatchedExecutionCount: perRun.size - retained.length,
    scorerStatus: 'EXTERNAL_SCORECARDS_RECORDED_NOT_INDEPENDENTLY_AUTHENTICATED',
    physicalAcceptance: 'NOT_VERIFIED', releaseAcceptance: 'NOT_ACCEPTED',
    note: 'Hashed transcripts and third-party-labelled scorecards preserve provenance, but scorer identity, raw observation content and objective outcomes require independent authentication.'
  };
  return { manifest, traceJsonl, scorecardJsonl };
}

export async function recordWave0Bundle({ inputPath, outputDirectory, sourceCommit }) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const bundle = buildWave0TraceBundle({ ...input, sourceCommit });
  await fs.mkdir(outputDirectory, { recursive: true });
  const basename = bundle.manifest.traceSha256;
  // Never overwrite evidence from a distinct prior run, even when IDs happen to match.
  const destination = path.join(outputDirectory, basename);
  await fs.mkdir(destination);
  await Promise.all([
    fs.writeFile(path.join(destination, 'steps.jsonl'), bundle.traceJsonl, { flag: 'wx', mode: 0o600 }),
    fs.writeFile(path.join(destination, 'scorecards.jsonl'), bundle.scorecardJsonl, { flag: 'wx', mode: 0o600 }),
    fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  ]);
  return { directory: destination, ...bundle.manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 6 || process.argv[2] !== '--input' || process.argv[4] !== '--output-dir') {
    throw new Error('Usage: node scripts/wave0-step-evidence.mjs --input <record.json> --output-dir <empty-artifact-folder>');
  }
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  const result = await recordWave0Bundle({ inputPath: process.argv[3],
    outputDirectory: process.argv[5], sourceCommit });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
