import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTestCandidateRequest } from '../scripts/npm-test-candidate-policy.mjs';

const sha = 'a'.repeat(40);
const good = {
  repository: 'sampathkumar-co/Operator-runtime',
  ref: 'refs/heads/main',
  workflowSha: sha,
  checkoutSha: sha,
  currentVersion: '2.0.6',
  candidateVersion: '2.0.7-rc.1'
};

test('isolated npm testing candidate does not authorize production or registry mutation', () => {
  const result = validateTestCandidateRequest(good);
  assert.equal(result.status, 'TEST_ARTIFACT_ONLY');
  assert.equal(result.registryPublication, 'PROHIBITED');
  assert.equal(result.productionAcceptance, 'NOT_GRANTED');
  assert.equal(result.sourceCommit, sha);
  assert.equal(result.candidateVersion, good.candidateVersion);
});

test('test-only packaging rejects foreign repositories, release branches, and unpinned checkouts', () => {
  for (const input of [
    { repository: 'other/project' },
    { ref: 'refs/heads/development' },
    { workflowSha: 'b'.repeat(40) },
    { checkoutSha: 'not-a-sha' },
    { workflowSha: { toString: () => sha } }
  ]) {
    assert.throws(() => validateTestCandidateRequest({ ...good, ...input }), /NPM_TEST_ONLY_DENIED/);
  }
});

test('test-only packaging refuses stable tags, injected semver, stale baselines, or version coercion', () => {
  for (const input of [
    { currentVersion: '2.0.7' },
    { candidateVersion: '2.0.7' },
    { candidateVersion: '2.0.7-rc.0' },
    { candidateVersion: '2.0.7-rc.1; npm publish' },
    { candidateVersion: '2.0.8-rc.1' },
    { candidateVersion: { toString: () => '2.0.7-rc.1' } }
  ]) {
    assert.throws(() => validateTestCandidateRequest({ ...good, ...input }), /NPM_TEST_ONLY_DENIED/);
  }
});
