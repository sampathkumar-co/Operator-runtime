import { fileURLToPath } from 'node:url';

export const REQUIRED_RELEASE_WORKFLOWS = Object.freeze([
  'CI',
  'Platform Matrix',
  'Windows Signing Smoke'
]);

function fail(message) {
  throw new Error(message);
}

export function validateReleaseSourceEvidence({ sha, pullRequests, workflowRuns }) {
  const commitSha = String(sha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) fail('Release source SHA must be a full 40-character commit SHA.');
  if (!Array.isArray(pullRequests)) fail('Release source pull-request evidence is missing.');
  if (!Array.isArray(workflowRuns)) fail('Release source workflow evidence is missing.');

  const mergedPullRequests = pullRequests.filter((pr) =>
    pr?.state === 'closed' &&
    Boolean(pr?.merged_at) &&
    pr?.base?.ref === 'main' &&
    String(pr?.merge_commit_sha ?? '').toLowerCase() === commitSha
  );
  if (mergedPullRequests.length < 1) {
    fail('Release source commit must be the exact merge commit of a merged pull request into main.');
  }

  const acceptedRuns = {};
  for (const workflowName of REQUIRED_RELEASE_WORKFLOWS) {
    const candidates = workflowRuns
      .filter((run) =>
        run?.name === workflowName &&
        run?.event === 'push' &&
        run?.head_branch === 'main' &&
        String(run?.head_sha ?? '').toLowerCase() === commitSha
      )
      .sort((a, b) => String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')));
    const run = candidates[0];
    if (!run) fail(`Release source is missing required ${workflowName} push evidence.`);
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      fail(`Required ${workflowName} run is not green (status=${run.status ?? 'unknown'}, conclusion=${run.conclusion ?? 'unknown'}).`);
    }
    acceptedRuns[workflowName] = run.id;
  }

  return {
    sha: commitSha,
    pullRequestNumbers: mergedPullRequests.map((pr) => pr.number).filter(Number.isInteger),
    workflowRunIds: acceptedRuns
  };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'operator-release-source-gate'
    }
  });
  if (!response.ok) fail(`GitHub release-source query failed for ${path} (HTTP ${response.status}).`);
  return response.json();
}

export async function verifyReleaseSource({ repository, sha, token }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? ''))) fail('Invalid GITHUB_REPOSITORY.');
  if (!String(token ?? '').trim()) fail('GITHUB_TOKEN is required for the release-source gate.');
  const encodedSha = encodeURIComponent(String(sha));
  const pullRequests = await githubJson(`/repos/${repository}/commits/${encodedSha}/pulls`, token);
  const runsPayload = await githubJson(`/repos/${repository}/actions/runs?head_sha=${encodedSha}&branch=main&per_page=100`, token);
  const evidence = validateReleaseSourceEvidence({ sha, pullRequests, workflowRuns: runsPayload.workflow_runs });
  console.log(`operator-release-source:PASS sha=${evidence.sha} pr=${evidence.pullRequestNumbers.join(',')} runs=${JSON.stringify(evidence.workflowRunIds)}`);
  return evidence;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  if (process.env.GITHUB_REF !== 'refs/heads/main') fail('Production release must run from refs/heads/main.');
  await verifyReleaseSource({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN
  });
}
