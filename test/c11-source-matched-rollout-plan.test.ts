import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSourceMatchedRolloutPlan } from '../scripts/c11-source-matched-rollout-plan.mjs';

const old = 'a'.repeat(40);
const next = 'b'.repeat(40);
const digest = 'c'.repeat(64);
const workloads = [
  { name: 'other-app', digest, state: 'running' },
  { name: 'other-db', digest: 'd'.repeat(64), state: 'running' }
];
const services = ['relay', 'public-mcp', 'developer-mcp'];
function plan() {
  return {
    schemaVersion: 1, candidateSha: next, packageSourceSha: next, lastGoodSha: old,
    backupSha256: 'e'.repeat(64), hostKeyFingerprintSha256: 'f'.repeat(64),
    beforeServices: services.map(name => ({ name, sourceCommit: old })),
    afterServices: services.map(name => ({ name, sourceCommit: next })),
    unrelatedWorkloadsBefore: structuredClone(workloads),
    unrelatedWorkloadsAfter: structuredClone(workloads),
    stageOrder: ['STAGING_READ_ONLY', 'CANARY_READ_ONLY', 'CANARY_REVERSIBLE',
      'OWNER_APPROVED_WRITE', 'POST_DEPLOY_MONITOR']
  };
}
test('C11 consistent three-service rehearsal is NOT release or deployment authorization', () => {
  const value = assessSourceMatchedRolloutPlan(plan());
  assert.equal(value.status, 'DRY_RUN_DECLARATIONS_CONSISTENT');
  assert.equal(value.deploymentAuthorized, false);
  assert.equal(value.releaseAccepted, false);
  assert.equal(value.independentlyAuthenticated, false);
  assert.equal(value.unchangedOtherWorkloadCount, 2);
  assert.match(value.reportSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(assessSourceMatchedRolloutPlan(plan()), value);
});
test('C11 blocks mixed source services, source drift and missing rollback provenance', () => {
  const edits = [
    p => { p.packageSourceSha = old; },
    p => { p.beforeServices[1].sourceCommit = next; },
    p => { p.afterServices[2].sourceCommit = old; },
    p => { p.beforeServices.push(p.beforeServices[0]); },
    p => { p.backupSha256 = 'not-a-hash'; },
    p => { p.hostKeyFingerprintSha256 = 'invalid'; },
    p => { p.stageOrder = ['OWNER_APPROVED_WRITE', 'STAGING_READ_ONLY']; }
  ];
  for (const edit of edits) {
    const p = plan(); edit(p);
    assert.throws(() => assessSourceMatchedRolloutPlan(p), /C11_ROLLOUT_PLAN_INVALID/);
  }
});
test('C11 blocks changing an unrelated VPS workload and injected arbitrary keys', () => {
  const edits = [
    p => { p.unrelatedWorkloadsAfter[0].state = 'exited'; },
    p => { p.unrelatedWorkloadsAfter[1].digest = '0'.repeat(64); },
    p => { p.unrelatedWorkloadsAfter.pop(); },
    p => { p.unrelatedWorkloadsAfter.push({ name: 'new', digest, state: 'running' }); },
    p => { p.unrelatedWorkloadsAfter[0].secret = 'forbidden'; },
    p => { p.afterServices[0].token = 'must not be accepted'; },
    p => { p.unrelatedWorkloadsAfter[0].name = '../escape'; }
  ];
  for (const edit of edits) {
    const p = plan(); edit(p);
    assert.throws(() => assessSourceMatchedRolloutPlan(p), /C11_ROLLOUT_PLAN_INVALID/);
  }
});
