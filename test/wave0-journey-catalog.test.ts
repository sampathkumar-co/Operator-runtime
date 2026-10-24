import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { currentJourneyCandidates, validateJourneyCandidates } from '../scripts/wave0-journey-catalog.mjs';

const source = new URL('../certification/wave0/realistic-journey-candidates-v1.json', import.meta.url);
const load = async () => JSON.parse(await fs.readFile(source, 'utf8'));
test('candidate suite contains exactly 50 unique realistic goals in 10 distinct domains', async () => {
  const result = await currentJourneyCandidates();
  assert.equal(result.totalCandidateJourneys, 50);
  assert.equal(result.domainCount, 10);
  assert.equal(result.executionStatus, 'NOT_RUN');
  assert.equal(result.independence, 'PUBLIC_NOT_SEALED_OR_HELD_OUT');
  assert.equal(result.releaseAcceptance, 'NOT_ACCEPTED');
  assert.match(result.candidateDescriptionsSha256, /^[0-9a-f]{64}$/);
});
test('a duplicate or unbalanced domain cannot masquerade as 50 unique evaluation journeys', async () => {
  const r = await load();
  r.journeys[1].goal = r.journeys[0].goal;
  assert.throws(() => validateJourneyCandidates(r), /duplicated user goal/);
  const other = await load();
  other.journeys[0].domain = other.journeys[6].domain;
  assert.throws(() => validateJourneyCandidates(other), /domain balance/);
});
test('catalogue entries may never claim evaluated outcomes or executable fixtures', async () => {
  const r = await load();
  r.journeys[0].outcome = 'PASSED';
  assert.throws(() => validateJourneyCandidates(r), /unsupported success claim/);
  const other = await load();
  other.score = '50/50';
  assert.throws(() => validateJourneyCandidates(other), /independent empirical evaluation/);
});
test('an absent postcondition or live authority is rejected before handing off to a runner', async () => {
  const r = await load();
  r.journeys[0].oracle = 'ok';
  assert.throws(() => validateJourneyCandidates(r), /postcondition/);
  const other = await load();
  other.journeys[0].authority = 'LIVE_ADMIN';
  assert.throws(() => validateJourneyCandidates(other), /live account permission/);
});
