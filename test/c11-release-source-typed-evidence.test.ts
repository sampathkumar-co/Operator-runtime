import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReleaseSourceEvidence } from '../scripts/verify-release-source.mjs';

const sha = 'a'.repeat(40);
const pr = {
  number: 123,
  state: 'closed',
  merged_at: '2026-10-25T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: 'main' }
};
const specs = [
  ['CI', '.github/workflows/ci.yml'],
  ['Platform Matrix', '.github/workflows/platform-matrix.yml'],
  ['Windows Signing Smoke', '.github/workflows/windows-signing-smoke.yml'],
  ['NPM Remote Runtime CI', '.github/workflows/npm-remote-ci.yml']
];
function runs() {
  return specs.map(([name, workflowPath], index) => ({
    id: index + 1, name, path: workflowPath, event: 'push',
    head_branch: 'main', head_sha: sha,
    status: 'completed', conclusion: 'success',
    created_at: '2026-10-25T00:00:00Z'
  }));
}

test('C11 exact merged source and four GitHub push jobs remain accepted', () => {
  const evidence = validateReleaseSourceEvidence({ sha, pullRequests: [pr], workflowRuns: runs() });
  assert.deepEqual(evidence.pullRequestNumbers, [123]);
  assert.equal(evidence.workflowRunIds.CI, 1);
});

test('C11 never stringifies attacker-owned release evidence into a pass', () => {
  let called = 0;
  const forged = {
    toString() { called++; return sha; },
    valueOf() { called++; return 123; }
  };
  assert.throws(() => validateReleaseSourceEvidence({
    sha: forged, pullRequests: [pr], workflowRuns: runs()
  }), /40-character commit SHA/);
  assert.throws(() => validateReleaseSourceEvidence({
    sha, pullRequests: [{ ...pr, merge_commit_sha: forged }], workflowRuns: runs()
  }), /exact merge commit/);
  assert.throws(() => validateReleaseSourceEvidence({
    sha, pullRequests: [{ ...pr, merged_at: forged }], workflowRuns: runs()
  }), /exact merge commit/);
  assert.throws(() => validateReleaseSourceEvidence({
    sha, pullRequests: [{ ...pr, number: forged }], workflowRuns: runs()
  }), /exact merge commit/);
  assert.throws(() => validateReleaseSourceEvidence({
    sha, pullRequests: [pr], workflowRuns: runs().map(run =>
      run.name === 'CI' ? { ...run, head_sha: forged } : run)
  }), /missing required CI push evidence/);
  assert.equal(called, 0, 'No hostile conversion hook may run on certification input');
});

test('C11 wrong typed run IDs and invented timestamps cannot certify successful runs', () => {
  for (const corrupted of [
    { id: '1' }, { id: null }, { id: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 }, { created_at: {} },
    { created_at: 'not-a-date' }
  ]) {
    assert.throws(() => validateReleaseSourceEvidence({
      sha, pullRequests: [pr],
      workflowRuns: runs().map(run => run.name === 'CI' ? { ...run, ...corrupted } : run)
    }), /missing required CI push evidence/);
  }
});
