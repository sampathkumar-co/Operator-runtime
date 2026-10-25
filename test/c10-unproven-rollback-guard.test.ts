import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecoveryCenterModel } from '../src/core/control-center-ux.ts';

const timestamp = '2026-10-25T17:00:00.000Z';
function candidate(verificationStatus) {
  return {
    actionId: 'user-task-1', capability: 'workspace.edit.transaction',
    retryable: true, sideEffectState: 'known',
    rollbackAvailable: true, verificationStatus,
    updatedAt: timestamp
  };
}
test('C10 owner UI never recommends undoing a successful effect on verification alone', () => {
  const [item] = buildRecoveryCenterModel([candidate('passed')]).items;
  assert.equal(item.disposition, 'BLOCKED');
  assert.equal(item.recommendedAction, 'ESCALATE');
  assert.equal(item.requiresFreshApproval, false);
  assert.match(item.reason, /do not undo/);
});

test('C10 unknown or missing verification cannot fabricate rollback permission', () => {
  for (const status of ['unknown', undefined]) {
    const [item] = buildRecoveryCenterModel([candidate(status)]).items;
    assert.equal(item.disposition, 'BLOCKED');
    assert.equal(item.recommendedAction, 'ESCALATE');
    assert.equal(item.requiresFreshApproval, false);
  }
});

test('C10 failed independent verification with known effect still offers fresh-authority rollback', () => {
  const [item] = buildRecoveryCenterModel([
    { ...candidate('failed'), reconciliationStatus: 'completed' }
  ]).items;
  assert.equal(item.disposition, 'REVERSIBLE');
  assert.equal(item.recommendedAction, 'ROLLBACK');
  assert.equal(item.requiresFreshApproval, true);
});
