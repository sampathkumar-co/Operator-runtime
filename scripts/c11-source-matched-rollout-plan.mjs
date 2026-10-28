// C11 source-only deployment rehearsal contract. No networking, SSH, Docker,
// deployment, secret access, owner authorization, or service mutation.
import crypto from 'node:crypto';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9._-]{1,63}$/;
const STAGES = Object.freeze([
  'STAGING_READ_ONLY', 'CANARY_READ_ONLY', 'CANARY_REVERSIBLE',
  'OWNER_APPROVED_WRITE', 'POST_DEPLOY_MONITOR'
]);
const TARGETS = Object.freeze(['relay', 'public-mcp', 'developer-mcp']);
const fail = message => { throw new Error('C11_ROLLOUT_PLAN_INVALID: ' + message); };
function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail(label + ' has unexpected fields');
  }
}
function sha(value, label, regex = SHA) {
  if (typeof value !== 'string' || !regex.test(value)) fail(label + ' is not a canonical digest');
  return value;
}
function serviceMap(list, label) {
  if (!Array.isArray(list) || list.length !== TARGETS.length) fail(label + ' requires three exact services');
  const out = new Map();
  for (const row of list) {
    exactKeys(row, ['name', 'sourceCommit'], label + ' row');
    if (!TARGETS.includes(row.name) || out.has(row.name)) fail(label + ' has unknown or duplicate service');
    out.set(row.name, sha(row.sourceCommit, label + ' source'));
  }
  return out;
}
function workloadMap(list, label) {
  if (!Array.isArray(list) || list.length > 200) fail(label + ' has an invalid workload census');
  const map = new Map();
  for (const row of list) {
    exactKeys(row, ['name', 'digest', 'state'], label + ' row');
    if (typeof row.name !== 'string' || !NAME.test(row.name) || map.has(row.name) ||
      typeof row.state !== 'string' || !['running', 'exited', 'paused'].includes(row.state)) {
      fail(label + ' contains an invalid or repeated workload');
    }
    map.set(row.name, { digest: sha(row.digest, label + ' digest', DIGEST), state: row.state });
  }
  return map;
}
export function assessSourceMatchedRolloutPlan(plan) {
  exactKeys(plan, [
    'schemaVersion', 'candidateSha', 'packageSourceSha', 'lastGoodSha',
    'backupSha256', 'hostKeyFingerprintSha256', 'beforeServices', 'afterServices',
    'unrelatedWorkloadsBefore', 'unrelatedWorkloadsAfter', 'stageOrder'
  ], 'plan');
  if (plan.schemaVersion !== 1) fail('unknown schema');
  const candidate = sha(plan.candidateSha, 'candidate');
  if (sha(plan.packageSourceSha, 'package') !== candidate) fail('candidate and package source differ');
  const lastGood = sha(plan.lastGoodSha, 'last good');
  if (candidate === lastGood) fail('candidate cannot be identical to last-good source');
  sha(plan.backupSha256, 'backup', DIGEST);
  sha(plan.hostKeyFingerprintSha256, 'pinned host key', DIGEST);
  if (!Array.isArray(plan.stageOrder) || plan.stageOrder.join('|') !== STAGES.join('|')) {
    fail('must retain staging, read-only, reversible, owner-approval and monitoring order');
  }
  const before = serviceMap(plan.beforeServices, 'before services');
  const after = serviceMap(plan.afterServices, 'after services');
  for (const target of TARGETS) {
    if (before.get(target) !== lastGood || after.get(target) !== candidate) {
      fail('all three services must progress from the same last-good to exact candidate source');
    }
  }
  const otherBefore = workloadMap(plan.unrelatedWorkloadsBefore, 'other workloads before');
  const otherAfter = workloadMap(plan.unrelatedWorkloadsAfter, 'other workloads after');
  if (otherBefore.size !== otherAfter.size) fail('unrelated workload census changed');
  for (const [name, state] of otherBefore) {
    const next = otherAfter.get(name);
    if (!next || next.digest !== state.digest || next.state !== state.state) {
      fail('unrelated workload changed');
    }
  }
  // These are caller-declared observations, not authenticated live evidence.
  // A passing rehearsal MUST NEVER authorize writes, owner signoff or publication.
  const payload = {
    schemaVersion: 1, candidateSha: candidate, lastGoodSha: lastGood,
    plannedStages: [...STAGES], targetServices: [...TARGETS],
    unchangedOtherWorkloadCount: otherBefore.size,
    declarationConsistent: true, independentlyAuthenticated: false,
    deploymentAuthorized: false, releaseAccepted: false,
    status: 'DRY_RUN_DECLARATIONS_CONSISTENT',
    caveat: 'No live host attestation, verified backup restoration, protected original receipts, canary results or owner approval.'
  };
  return { ...payload, reportSha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
