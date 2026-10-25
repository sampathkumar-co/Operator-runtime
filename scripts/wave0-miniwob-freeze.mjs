import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KNOWN_BROWSERGYM_COMMIT = '0a785fbed075224ae81ca9c1fe924f66050696fe';
export const KNOWN_METADATA_BLOB = 'ac52b19f4e262295f4a9dfeed4d5a490e0c47a6d';
export const KNOWN_ROSTER_BLOB = '803f9cfe5120450d5117f8ac28b3eca3c68da5cc';
export const KNOWN_MINIWOB_FIXTURE = '7fd85d71a4b60325c6585396ec4f48377d049838';
const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TASK = /^miniwob\.[a-z0-9-]+$/;
const REQUIRED_SEEDS = Object.freeze([0, 42]);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const gitBlobHash = bytes => crypto.createHash('sha1')
  .update('blob ' + Buffer.byteLength(bytes) + '\0')
  .update(bytes).digest('hex');
function requireState(value, message) {
  if (!value) throw new Error('WAVE0_MINIWOB_FREEZE_INVALID: ' + message);
}
function exact(x, label) {
  requireState(typeof x === 'string' && DIGEST.test(x), label + ' must be SHA256');
}
export function verifyFrozenMiniwobRoster(roster, executionConfig = null) {
  requireState(roster && typeof roster === 'object' && !Array.isArray(roster), 'roster must be an object');
  requireState(roster.schemaVersion === 1 && roster.benchmark === 'BrowserGym MiniWoB++', 'schema/benchmark differs');
  const b = roster.browserGym;
  requireState(b?.repository === 'ServiceNow/BrowserGym' && b.tag === 'v0.14.3' &&
    b.tagCommit === KNOWN_BROWSERGYM_COMMIT && b.metadataGitBlobSha1 === KNOWN_METADATA_BLOB,
    'upstream BrowserGym tag and exact metadata blob drifted');
  requireState(roster.historicalMiniWobFixtureCommit === KNOWN_MINIWOB_FIXTURE,
    'historical MiniWoB fixture commit differs from existing evidence');
  requireState(Array.isArray(roster.taskIds) && roster.taskIds.length === 125 &&
    new Set(roster.taskIds).size === 125 && roster.taskIds.every(id => typeof id === 'string' && TASK.test(id)),
    'exactly 125 unique canonical task identifiers required');
  requireState(roster.taskIds.every((value, i) => i === 0 || roster.taskIds[i - 1] < value),
    'task roster must be lexicographically ordered for stable source comparison');
  const taskNamesBytes = roster.taskIds.join('\n') + '\n';
  requireState(gitBlobHash(taskNamesBytes) === KNOWN_ROSTER_BLOB &&
    roster.taskRosterGitBlobSha1 === KNOWN_ROSTER_BLOB, 'frozen roster content mismatch');
  const c = roster.benchmarkConfig;
  requireState(c?.id === 'miniwob' && c.taskCount === 125 &&
    c.defaultRepeats === 5 && c.seedRng === 'numpy.RandomState(42)' &&
    c.maxSteps === 10, 'official benchmark seed/repeat/step contract drifted');
  requireState(roster.score === 'NOT_RUN' && roster.sourceMode === 'FROZEN_ROSTER_ONLY',
    'suite freeze must not invent actual run success');
  let execution = { status: 'NOT_LOCKED', reason: 'No real model/controller/prompt/environment or actual spend configured.' };
  if (executionConfig !== null) {
    const cfg = executionConfig;
    requireState(cfg && typeof cfg === 'object' && !Array.isArray(cfg), 'executionConfig invalid');
    for (const k of ['model', 'modelVersion', 'environmentCommit', 'runnerCommit', 'browserVersion']) {
      requireState(typeof cfg[k] === 'string' && cfg[k].length > 0 &&
        !cfg[k].includes('NOT_') && cfg[k].length <= 128, 'missing execution pin: ' + k);
    }
    requireState(FULL_SHA.test(cfg.environmentCommit) && FULL_SHA.test(cfg.runnerCommit),
      'exact environment and runner source SHA required');
    for (const k of ['promptSha256', 'controllerSha256', 'modelConfigSha256', 'scorerSha256']) exact(cfg[k], k);
    requireState(Number.isSafeInteger(cfg.maxModelCallsPerEpisode) && cfg.maxModelCallsPerEpisode >= 1 &&
      cfg.maxModelCallsPerEpisode <= 30, 'bounded model call budget required');
    requireState(Number.isSafeInteger(cfg.maxCostMicrosTotal) && cfg.maxCostMicrosTotal > 0,
      'bounded model spend budget required');
    requireState(Array.isArray(cfg.seeds) && cfg.seeds.length >= 3 &&
      cfg.seeds.every(x => Number.isSafeInteger(x) && x >= 0) &&
      new Set(cfg.seeds).size === cfg.seeds.length &&
      REQUIRED_SEEDS.every(seed => cfg.seeds.includes(seed)),
      'frozen seeds must include 0, 42 and at least one additional preregistered seed');
    execution = { status: 'CONFIG_LOCKED_NOT_EXECUTED', configSha256: hash(JSON.stringify(cfg)),
      model: cfg.model, modelVersion: cfg.modelVersion, seeds: cfg.seeds,
      maxCostMicrosTotal: cfg.maxCostMicrosTotal, maxModelCallsPerEpisode: cfg.maxModelCallsPerEpisode };
  }
  return {
    schemaVersion: 1, benchmark: 'BrowserGym MiniWoB++', version: 'v0.14.3',
    upstreamSourceCommit: b.tagCommit, upstreamMetadataBlob: b.metadataGitBlobSha1,
    historicalFixtureCommit: roster.historicalMiniWobFixtureCommit,
    historicalFixtureCheckout: 'NOT_VERIFIED',
    officialTaskCount: 125, taskRosterGitBlobSha1: KNOWN_ROSTER_BLOB,
    taskRosterSha256: hash(taskNamesBytes), seedGenerator: c.seedRng,
    benchmarkDefaultEpisodes: 125 * 5, maxStepsPerEpisode: 10,
    execution, physicalBrowserRun: 'NOT_RUN', nativeScorerOutcome: 'NOT_RUN',
    releaseAcceptance: 'NOT_ACCEPTED',
    caveats: [
      '125 official task identities are source-locked, not evaluated.',
      'A pinned model budget is only a campaign configuration, not model inference or reward evidence.',
      'Historical MiniWoB fixture revision still requires checkout/build authentication on the actual test host.'
    ]
  };
}
export async function currentFrozenMiniwobRoster(executionConfig = null) {
  const source = new URL('../certification/wave0/miniwob-125-v0143.json', import.meta.url);
  const roster = JSON.parse(await fs.readFile(source, 'utf8'));
  return verifyFrozenMiniwobRoster(roster, executionConfig);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const config = process.argv.length === 4 && process.argv[2] === '--config'
    ? JSON.parse(await fs.readFile(process.argv[3], 'utf8')) : null;
  if (process.argv.length !== 2 && !config) throw Error('Usage: node scripts/wave0-miniwob-freeze.mjs [--config external-model-campaign.json]');
  process.stdout.write(JSON.stringify(await currentFrozenMiniwobRoster(config), null, 2) + '\n');
}
