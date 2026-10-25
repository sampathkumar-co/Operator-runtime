import fs from 'node:fs/promises';

const EXPECTED_REPOSITORY = 'sampathkumar-co/Operator-runtime';
const SHA = /^[0-9a-f]{40}$/;
const TEST_RC = /^2\.0\.7-rc\.[1-9][0-9]*$/;

export function validateTestCandidateRequest({
  repository, ref, workflowSha, checkoutSha, currentVersion, candidateVersion
}) {
  if (repository !== EXPECTED_REPOSITORY || ref !== 'refs/heads/main') {
    throw new Error('NPM_TEST_ONLY_DENIED: main of the authorized repository is required.');
  }
  if (typeof workflowSha !== 'string' || !SHA.test(workflowSha) ||
      typeof checkoutSha !== 'string' || !SHA.test(checkoutSha) ||
      workflowSha !== checkoutSha) {
    throw new Error('NPM_TEST_ONLY_DENIED: checkout must match the exact workflow SHA.');
  }
  if (currentVersion !== '2.0.6') {
    throw new Error('NPM_TEST_ONLY_DENIED: unexpected stable baseline; review the test candidate workflow before updating.');
  }
  if (typeof candidateVersion !== 'string' || !TEST_RC.test(candidateVersion) ||
      candidateVersion.length > 32) {
    throw new Error('NPM_TEST_ONLY_DENIED: only explicitly numbered 2.0.7 release-candidate versions are allowed.');
  }
  return Object.freeze({
    status: 'TEST_ARTIFACT_ONLY',
    candidateVersion,
    sourceCommit: checkoutSha,
    registryPublication: 'PROHIBITED',
    productionAcceptance: 'NOT_GRANTED',
    allowedInstallScope: 'ISOLATED_TEST_DIRECTORY'
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const pkg = JSON.parse(await fs.readFile(new URL('../packages/mecord-connect/package.json', import.meta.url), 'utf8'));
  const report = validateTestCandidateRequest({
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    workflowSha: process.env.GITHUB_SHA,
    checkoutSha: process.env.OPERATOR_CHECKOUT_SHA,
    currentVersion: pkg.version,
    candidateVersion: process.env.MECORD_TEST_CANDIDATE_VERSION
  });
  process.stdout.write(JSON.stringify(report) + '\n');
}
