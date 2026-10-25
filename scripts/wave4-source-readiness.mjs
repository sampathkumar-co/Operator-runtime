import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSTREAM_TASK_COUNTS = Object.freeze([9, 10, 10, 12, 10, 12, 12, 11, 13, 11, 11, 13]);
const WAVE_STREAMS = Object.freeze([[0, 1], [2, 3, 4, 6], [5, 7], [8, 9, 10], [11]]);
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CHECKBOX = /^- \[([ x])\] (C\d{2}-\d{2})\b/gm;
const INDEPENDENT_GATES = Object.freeze([
  'three_lane_real_model_scoring',
  'fifty_held_out_real_user_workflows',
  'official_125_miniwob_supplement',
  'original_windows_chrome_edge_uia',
  'original_two_host_receipt_recovery',
  'independent_authority_and_no_replay',
  'signed_package_provenance_and_rollback',
  'owner_accepted_canary_and_stop',
  'post_release_telemetry_and_owner_publish'
]);

function invalid(message) { throw new Error('WAVE4_SOURCE_READINESS_INVALID: ' + message); }
function checkSha(input) {
  if (typeof input !== 'string' || !SHA.test(input)) invalid('candidate SHA must be exact 40-character git SHA');
  return input;
}
export function evaluateWave4Readiness({ candidateSha, issues, parentState = 'open' }) {
  checkSha(candidateSha);
  if (!Array.isArray(issues) || issues.length !== 12 || parentState !== 'open') {
    invalid('require all 12 workstream issues and an open parent workboard');
  }
  const streams = [];
  const taskIds = new Set();
  for (let i = 0; i < WORKSTREAM_TASK_COUNTS.length; ++i) {
    const issue = issues.find(item => item?.number === 375 + i);
    if (!issue || typeof issue.body !== 'string' || issue.body.length > 200_000 ||
        issue.state !== 'open' || issues.filter(x => x?.number === issue.number).length !== 1) {
      invalid('missing, duplicate, closed or malformed workstream #' + (375 + i));
    }
    const target = 'C' + String(i).padStart(2, '0');
    const checklist = [...issue.body.matchAll(CHECKBOX)];
    const exact = checklist.filter(match => match[2].startsWith(target + '-'));
    const expected = WORKSTREAM_TASK_COUNTS[i];
    const ids = new Set();
    for (const match of exact) {
      const id = match[2];
      if (ids.has(id) || taskIds.has(id)) invalid('duplicate atomic checklist ID ' + id);
      ids.add(id); taskIds.add(id);
    }
    if (exact.length !== expected) {
      invalid('incorrect task count for ' + target + ': expected ' + expected + ', received ' + exact.length);
    }
    for (let t = 1; t <= expected; t++) {
      const id = target + '-' + String(t).padStart(2, '0');
      if (!ids.has(id)) invalid('canonical task missing ' + id);
    }
    const accepted = exact.filter(match => match[1] === 'x').map(match => match[2]).sort();
    const pending = exact.filter(match => match[1] === ' ').map(match => match[2]).sort();
    streams.push({ stream: target, issue: issue.number, expected, acceptedCount: accepted.length, pending });
  }
  const waves = WAVE_STREAMS.map((indices, index) => {
    const rows = indices.map(i => streams[i]);
    return {
      wave: index,
      required: rows.reduce((sum, row) => sum + row.expected, 0),
      sourceChecklistAccepted: rows.reduce((sum, row) => sum + row.acceptedCount, 0),
      pending: rows.flatMap(row => row.pending),
      completion: rows.every(row => row.pending.length === 0) ? 'SOURCE_CHECKLIST_ONLY' : 'INCOMPLETE'
    };
  });
  const acceptedCount = streams.reduce((sum, row) => sum + row.acceptedCount, 0);
  const pendingCount = streams.reduce((sum, row) => sum + row.pending.length, 0);
  if (acceptedCount + pendingCount !== 134) invalid('workboard does not enumerate exactly 134 tasks');

  // A repository checkbox is NOT an independent test artifact or release signature.
  // This script has no privilege to waive physical, hosted, benchmark or owner gates.
  const result = {
    schemaVersion: 1, candidateSha, canonicalTracker: 374,
    totalTasks: 134, sourceChecklistAccepted: acceptedCount, sourceChecklistPending: pendingCount,
    streams, waves,
    independentAcceptance: Object.fromEntries(INDEPENDENT_GATES.map(gate => [gate, 'NOT_AUTHENTICATED_IN_THIS_SOURCE_CHECK'])),
    releaseAuthorization: 'NOT_GRANTED',
    publicationAllowed: false,
    status: pendingCount ? 'CHECKLIST_INCOMPLETE' : 'SOURCE_CHECKLIST_ONLY_EXTERNAL_GATES_UNVERIFIED',
    limits: [
      'GitHub issue checkboxes are mutable owner-declared scope, not independently authenticated execution outcomes.',
      'This non-publishing report cannot qualify model scores, original Windows device state, hosted relay or signing.',
      'No source-only CI run is permission to stage, canary, sign, publish npm or close parent issue #374.'
    ]
  };
  return { ...result, reportSha256: crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}

async function fetchIssue(repository, number, token) {
  const response = await fetch('https://api.github.com/repos/' + repository + '/issues/' + number, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mecord-wave4-source-readiness'
    }, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) invalid('read-only GitHub issue #' + number + ' unavailable (HTTP ' + response.status + ')');
  const payload = await response.json();
  return { number: payload.number, body: payload.body, state: payload.state };
}

export async function checkpointCurrentCheckout({ repository, token }) {
  if (!REPOSITORY.test(repository ?? '') || typeof token !== 'string' || !token.trim()) {
    invalid('read-only repo and GITHUB_TOKEN are required');
  }
  const cwd = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim().toLowerCase();
  if (process.env.GITHUB_SHA && candidateSha !== process.env.GITHUB_SHA) {
    invalid('GitHub run SHA differs from source checkout SHA');
  }
  const numbers = Array.from({ length: 13 }, (_, i) => 374 + i);
  const results = [];
  for (let i = 0; i < numbers.length; i += 4) {
    results.push(...await Promise.all(numbers.slice(i, i + 4).map(n => fetchIssue(repository, n, token))));
  }
  return evaluateWave4Readiness({
    candidateSha, issues: results.filter(item => item.number !== 374),
    parentState: results.find(item => item.number === 374)?.state
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkpointCurrentCheckout({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
