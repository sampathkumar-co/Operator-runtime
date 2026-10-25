import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKSTREAM_TASK_COUNTS, evaluateWave4Readiness } from '../scripts/wave4-source-readiness.mjs';

const candidateSha = 'a'.repeat(40);
function makeIssues(all = false) {
  return WORKSTREAM_TASK_COUNTS.map((count, i) => ({
    number: i + 375, state: 'open',
    body: Array.from({ length: count }, (_, j) => {
      const task = 'C' + String(i).padStart(2, '0') + '-' + String(j + 1).padStart(2, '0');
      return '- [' + (all ? 'x' : j === 0 ? 'x' : ' ') + '] ' + task + ' task evidence requires independent verification';
    }).join('\n')
  }));
}
test('C11 source readiness counts all 134 unique atomic tasks across Waves 0-4 without granting release', () => {
  const report = evaluateWave4Readiness({ candidateSha, issues: makeIssues() });
  assert.equal(report.totalTasks, 134);
  assert.equal(report.sourceChecklistAccepted, 12);
  assert.equal(report.sourceChecklistPending, 122);
  assert.equal(report.waves.length, 5);
  assert.equal(report.waves[0].required, 19);
  assert.equal(report.waves[1].required, 44);
  assert.equal(report.waves[2].required, 23);
  assert.equal(report.waves[3].required, 35);
  assert.equal(report.waves[4].required, 13);
  assert.equal(report.status, 'CHECKLIST_INCOMPLETE');
  assert.equal(report.publicationAllowed, false);
  assert.equal(report.releaseAuthorization, 'NOT_GRANTED');
  assert.match(report.reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.independentAcceptance.original_two_host_receipt_recovery,
    'NOT_AUTHENTICATED_IN_THIS_SOURCE_CHECK');
});
test('C11 all green GitHub checkboxes never grant production release without independent external gates', () => {
  const report = evaluateWave4Readiness({ candidateSha, issues: makeIssues(true) });
  assert.equal(report.sourceChecklistAccepted, 134);
  assert.equal(report.sourceChecklistPending, 0);
  assert.equal(report.status, 'SOURCE_CHECKLIST_ONLY_EXTERNAL_GATES_UNVERIFIED');
  assert.ok(report.waves.every(wave => wave.completion === 'SOURCE_CHECKLIST_ONLY'));
  assert.equal(report.publicationAllowed, false);
  assert.equal(report.releaseAuthorization, 'NOT_GRANTED');
  assert.equal(Object.values(report.independentAcceptance).every(value =>
    value === 'NOT_AUTHENTICATED_IN_THIS_SOURCE_CHECK'), true);
});
test('C11 must see exact issue roster without gaps, duplicate IDs, or altered task cardinality', () => {
  const input = makeIssues();
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: input.slice(1) }),
    /require all 12/);
  const missing = makeIssues();
  missing[0].body = missing[0].body.replace(/^- \[[ x]\] C00-09.*$/m, '');
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: missing }),
    /incorrect task count/);
  const duplicate = makeIssues();
  duplicate[4].body = duplicate[4].body.replace('C04-10', 'C04-01');
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: duplicate }),
    /duplicate atomic checklist ID/);
  const injectedForeign = makeIssues(true);
  injectedForeign[0].body += '\n- [ ] C01-01 misplaced duplicate with no physical proof';
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: injectedForeign }),
    /task C01-01 is assigned outside C00/);
  const unexpectedForeign = makeIssues(true);
  unexpectedForeign[11].body += '\n- [x] C99-01 forged release acceptance';
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: unexpectedForeign }),
    /task C99-01 is assigned outside C11/);
  const closed = makeIssues();
  closed[11].state = 'closed';
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: closed }),
    /closed or malformed/);
});
test('C11 requires an exact candidate SHA and an open canonical parent issue', () => {
  assert.throws(() => evaluateWave4Readiness({ candidateSha: 'not-a-sha', issues: makeIssues() }),
    /candidate SHA/);
  assert.throws(() => evaluateWave4Readiness({ candidateSha, issues: makeIssues(), parentState: 'closed' }),
    /open parent/);
  const output = evaluateWave4Readiness({ candidateSha, issues: makeIssues() });
  assert.equal(output.reportSha256, evaluateWave4Readiness({ candidateSha, issues: makeIssues() }).reportSha256);
});
