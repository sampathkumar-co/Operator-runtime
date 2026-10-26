import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchReleaseWorkflowRuns, validateReleaseSourceEvidence
} from '../scripts/verify-release-source.mjs';

const sha = 'a'.repeat(40);
const commit = { number: 789, state: 'closed', merged_at: '2026-10-26T08:00:00Z',
  merge_commit_sha: sha, base: { ref: 'main' } };
const reqs = [
  ['CI', '.github/workflows/ci.yml'],
  ['Platform Matrix', '.github/workflows/platform-matrix.yml'],
  ['Windows Signing Smoke', '.github/workflows/windows-signing-smoke.yml'],
  ['NPM Remote Runtime CI', '.github/workflows/npm-remote-ci.yml']
] as const;
const filler = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1, name: 'Optional workflow ' + index,
  path: '.github/workflows/optional.yml',
  event: 'push', head_branch: 'main', head_sha: sha,
  status: 'completed', conclusion: 'success', created_at: '2026-10-26T08:00:00Z'
}));
const required = reqs.map(([name, workflowPath], index) => ({
  id: 101 + index, name, path: workflowPath,
  event: 'push', head_branch: 'main', head_sha: sha,
  status: 'completed', conclusion: 'success', created_at: '2026-10-26T08:00:01Z'
}));

test('C11 source certification reads later pages for the exact main candidate SHA', async () => {
  const requested: string[] = [];
  const workflowRuns = await fetchReleaseWorkflowRuns({
    repository: 'org/repo', sha, token: 'dummy',
    getJson: async (url: string) => {
      requested.push(url);
      return { workflow_runs: url.endsWith('page=1') ? filler : required };
    }
  });
  assert.equal(requested.length, 2);
  assert.equal(workflowRuns.length, 104);
  assert.ok(requested.every(url => url.includes('head_sha=' + sha) &&
    url.includes('branch=main') && url.includes('per_page=100')));
  const verified = validateReleaseSourceEvidence({
    sha, pullRequests: [commit], workflowRuns
  });
  assert.deepEqual(verified.pullRequestNumbers, [789]);
  assert.equal(verified.workflowRunIds['NPM Remote Runtime CI'], 104);
});

test('C11 duplicate and malformed workflow pages fail closed', async () => {
  await assert.rejects(fetchReleaseWorkflowRuns({
    repository: 'org/repo', sha, token: 'dummy',
    getJson: async (url: string) => ({
      workflow_runs: url.endsWith('page=1') ? filler : [filler[0]]
    })
  }), /duplicated run identities/);
  await assert.rejects(fetchReleaseWorkflowRuns({
    repository: 'org/repo', sha, token: 'dummy',
    getJson: async () => ({ workflow_runs: { fake: true } })
  }), /page is malformed/);
  await assert.rejects(fetchReleaseWorkflowRuns({
    repository: 'org/repo', sha, token: 'dummy',
    getJson: async () => ({ workflow_runs: filler })
  }), /bounded pagination window/);
});
