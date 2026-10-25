import assert from 'node:assert/strict';
import test from 'node:test';
import { currentFrozenMiniwobRoster, verifyFrozenMiniwobRoster } from '../scripts/wave0-miniwob-freeze.mjs';
import fs from 'node:fs/promises';

const path = new URL('../certification/wave0/miniwob-125-v0143.json', import.meta.url);
const load = async () => JSON.parse(await fs.readFile(path, 'utf8'));
test('official BrowserGym 0.14.3 MiniWoB roster has 125 distinct SHA-bound tasks but zero invented results', async () => {
  const r = await currentFrozenMiniwobRoster();
  assert.equal(r.officialTaskCount, 125);
  assert.equal(r.benchmarkDefaultEpisodes, 625);
  assert.equal(r.maxStepsPerEpisode, 10);
  assert.equal(r.execution.status, 'NOT_LOCKED');
  assert.equal(r.physicalBrowserRun, 'NOT_RUN');
  assert.equal(r.nativeScorerOutcome, 'NOT_RUN');
  assert.equal(r.releaseAcceptance, 'NOT_ACCEPTED');
});
test('a substituted MiniWoB task or reordered list cannot silently become the fixed source roster', async () => {
  const r = await load();
  r.taskIds[0] = 'miniwob.fake-task';
  assert.throws(() => verifyFrozenMiniwobRoster(r), /frozen roster content mismatch|lexicographically ordered/);
  const original = await load();
  original.taskIds.reverse();
  assert.throws(() => verifyFrozenMiniwobRoster(original), /lexicographically ordered/);
});
test('registered MiniWoB fixture, version and step budgets are immutable', async () => {
  const r = await load();
  r.browserGym.tagCommit = 'f'.repeat(40);
  assert.throws(() => verifyFrozenMiniwobRoster(r), /tag and exact metadata blob drifted/);
  const other = await load();
  other.benchmarkConfig.maxSteps = 999;
  assert.throws(() => verifyFrozenMiniwobRoster(other), /seed\/repeat\/step contract drifted/);
});
test('execution configuration must be reproducibly pinned before even describing it as locked', async () => {
  const r = await load();
  const cfg = {
    model: 'example-model', modelVersion: '1.2.3',
    environmentCommit: 'a'.repeat(40), runnerCommit: 'b'.repeat(40),
    browserVersion: 'chromium-pinned', promptSha256: 'c'.repeat(64),
    controllerSha256: 'd'.repeat(64), modelConfigSha256: 'e'.repeat(64),
    scorerSha256: 'f'.repeat(64), maxModelCallsPerEpisode: 12,
    maxCostMicrosTotal: 200000, seeds: [0, 42, 2026]
  };
  assert.equal(verifyFrozenMiniwobRoster(r, cfg).execution.status, 'CONFIG_LOCKED_NOT_EXECUTED');
  assert.equal(verifyFrozenMiniwobRoster(r, cfg).nativeScorerOutcome, 'NOT_RUN');
  assert.throws(() => verifyFrozenMiniwobRoster(r, { ...cfg, promptSha256: 'unhashed' }), /must be SHA256/);
  assert.throws(() => verifyFrozenMiniwobRoster(r, { ...cfg, seeds: [0, 42] }), /at least one additional/);
  assert.throws(() => verifyFrozenMiniwobRoster(r, { ...cfg, seeds: [0, 1, 2] }), /include 0, 42/);
  assert.throws(() => verifyFrozenMiniwobRoster(r, { ...cfg, seeds: [0, 42, 42] }), /additional preregistered seed/);
  assert.throws(() => verifyFrozenMiniwobRoster(r, { ...cfg, maxCostMicrosTotal: 0 }), /bounded model spend/);
});
