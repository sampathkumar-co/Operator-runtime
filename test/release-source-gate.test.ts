import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseSourceEvidence } from '../scripts/verify-release-source.mjs';

const sha = 'a'.repeat(40);
const pullRequests = [{
  number: 42,
  state: 'closed',
  merged_at: '2026-09-11T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: 'main' }
}];
const workflowRuns = ['CI', 'Platform Matrix', 'Windows Signing Smoke'].map((name, index) => ({
  id: index + 1,
  name,
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  created_at: `2026-09-11T00:00:0${index}Z`
}));

test('release source requires an exact merged PR and all required green main push workflows', () => {
  const result = validateReleaseSourceEvidence({ sha, pullRequests, workflowRuns });
  assert.deepEqual(result.pullRequestNumbers, [42]);
  assert.equal(result.workflowRunIds.CI, 1);
  assert.equal(result.workflowRunIds['Platform Matrix'], 2);
  assert.equal(result.workflowRunIds['Windows Signing Smoke'], 3);
});

test('release source rejects a direct-push commit without an associated merged PR', () => {
  assert.throws(
    () => validateReleaseSourceEvidence({ sha, pullRequests: [], workflowRuns }),
    /exact merge commit of a merged pull request/
  );
});

test('release source rejects missing, pending, or failed required workflow evidence', () => {
  assert.throws(
    () => validateReleaseSourceEvidence({ sha, pullRequests, workflowRuns: workflowRuns.filter((run) => run.name !== 'CI') }),
    /missing required CI push evidence/
  );
  assert.throws(
    () => validateReleaseSourceEvidence({
      sha,
      pullRequests,
      workflowRuns: workflowRuns.map((run) => run.name === 'Platform Matrix' ? { ...run, status: 'in_progress', conclusion: null } : run)
    }),
    /Platform Matrix run is not green/
  );
  assert.throws(
    () => validateReleaseSourceEvidence({
      sha,
      pullRequests,
      workflowRuns: workflowRuns.map((run) => run.name === 'Windows Signing Smoke' ? { ...run, conclusion: 'failure' } : run)
    }),
    /Windows Signing Smoke run is not green/
  );
});
