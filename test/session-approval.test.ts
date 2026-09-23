import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionRequest, PermissionProfile } from '../src/core/types.ts';
import { approvalAuthorityFingerprint, type ApprovalAuthorityContext, type ApprovalRecord } from '../apps/local-agent/src/approval-store.ts';
import { SessionApprovalStore } from '../apps/local-agent/src/session-approval.ts';

const authorityA: ApprovalAuthorityContext = {
  accountId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  generation: 3
};
const authorityB: ApprovalAuthorityContext = {
  accountId: '33333333-3333-4333-8333-333333333333',
  deviceId: authorityA.deviceId,
  generation: 3
};
const permissions: PermissionProfile = {
  allowedCapabilities: ['file.*', 'docker.*', 'browser.*', 'app.*', 'terminal.execute'],
  allowedRoots: ['C:\\Projects\\Mecord'],
  allowExternalWrites: false,
  allowSystemChanges: false,
  allowDestructive: false
};
const action: ActionRequest = {
  id: 'session-action',
  capability: 'file.replace',
  risk: 'destructive',
  input: { path: 'C:\\Projects\\Mecord\\a.txt' },
  provenance: { kind: 'chatgpt' }
};

function record(): ApprovalRecord {
  const createdAt = new Date('2026-09-23T10:00:00.000Z').toISOString();
  return {
    actionId: action.id,
    actionHash: 'a'.repeat(64),
    authorityHash: approvalAuthorityFingerprint(authorityA),
    approvalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    capability: action.capability,
    risk: action.risk,
    target: String(action.input.path),
    status: 'approved',
    createdAt,
    pendingExpiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
    approvedAt: createdAt,
    approvalExpiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString()
  };
}

test('session approval is authority and permission-scope bound', () => {
  let now = new Date('2026-09-23T10:00:00.000Z');
  const store = new SessionApprovalStore({ clock: () => now });
  const grant = store.grant(record(), permissions);
  assert.equal(store.summary().active, true);
  assert.match(grant.id, /^[0-9a-f-]{36}$/i);

  const allowed = store.permissionsFor(authorityA, permissions);
  assert.equal(allowed.allowExternalWrites, true);
  assert.equal(allowed.allowSystemChanges, true);
  assert.equal(allowed.allowDestructive, true);
  assert.deepEqual(allowed.allowedCapabilities, permissions.allowedCapabilities);
  assert.deepEqual(allowed.allowedRoots, permissions.allowedRoots);

  assert.equal(store.permissionsFor(authorityB, permissions).allowDestructive, false);
  assert.equal(store.permissionsFor({ ...authorityA, generation: 4 }, permissions).allowDestructive, false);
  assert.equal(store.permissionsFor(authorityA, { ...permissions, allowedRoots: ['C:\\Projects\\Other'] }).allowDestructive, false);

  now = new Date('2026-09-23T11:01:00.000Z');
  assert.equal(store.summary().active, false);
});

test('session approval absolute lifetime remains bounded even with use', () => {
  let now = new Date('2026-09-23T10:00:00.000Z');
  const store = new SessionApprovalStore({ clock: () => now });
  store.grant(record(), permissions);

  for (let minute = 50; minute < 8 * 60; minute += 50) {
    now = new Date(Date.parse('2026-09-23T10:00:00.000Z') + minute * 60_000);
    assert.equal(store.allows(action, authorityA, permissions), true);
  }
  now = new Date('2026-09-23T18:00:00.000Z');
  assert.equal(store.summary().active, false);
});
