import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlCenterHomeModel } from '../src/core/control-center-model.ts';
import type { DeveloperSession } from '../src/core/developer-session.ts';

function session(id: string, status: string): DeveloperSession {
  return {
    schemaVersion: 1, id, status,
    objective: 'Owned task', artifactIds: [], taskIds: [],
    updatedAt: '2026-10-26T00:00:00.000Z'
  } as unknown as DeveloperSession;
}

test('C10 persisted blockers and verification cannot be hidden by stale NONE attention', () => {
  const result = buildControlCenterHomeModel(
    [session('blocked', 'BLOCKED'), session('failed', 'FAILED'),
      session('verifying', 'VERIFYING'), session('complete', 'COMPLETED')],
    { blocked: 'NONE', failed: 'NONE', verifying: 'NONE', complete: 'NONE' }
  );
  assert.deepEqual(
    result.blockers.map(item => [item.id, item.attention]),
    [['blocked', 'BLOCKED'], ['failed', 'FAILED'], ['verifying', 'VERIFICATION_REQUIRED']]
  );
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.counts.verifying, 1);
  assert.equal(result.counts.failed, 1);
});

test('C10 more specific non-NONE attention stays visible, but inherited keys do not spoof hints', () => {
  const result = buildControlCenterHomeModel([
    session('reconcile', 'BLOCKED'), session('__proto__', 'COMPLETED')
  ], { reconcile: 'RECOVERY_REQUIRED' });
  assert.equal(result.blockers.find(item => item.id === 'reconcile')?.attention, 'RECOVERY_REQUIRED');
  assert.equal(result.blockers.some(item => item.id === '__proto__'), false);
});

test('C10 malformed attention hints cannot manufacture arbitrary statuses', () => {
  const subject = [session('task', 'COMPLETED')];
  assert.throws(() => buildControlCenterHomeModel(subject, { task: 'CLEAR' as any }),
    (error: any) => error?.code === 'CONTROL_CENTER_MODEL_INVALID');
  assert.throws(() => buildControlCenterHomeModel(subject, null as any),
    (error: any) => error?.code === 'CONTROL_CENTER_MODEL_INVALID');
});
