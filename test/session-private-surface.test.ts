import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { TOOL_NAMES } from '../apps/mcp-server/src/tool-surface.ts';
import { approvalAuthorityFingerprint, type ApprovalRecord } from '../apps/local-agent/src/approval-store.ts';
import { SessionApprovalStore } from '../apps/local-agent/src/session-approval.ts';
import { PolicyEngine } from '../src/core/policy.ts';
import type { ActionRequest, PermissionProfile } from '../src/core/types.ts';

test('private developer MCP surface remains exactly 24 semantic tools', () => {
  assert.equal(TOOL_NAMES.length, 24);
});

test('session grant suppresses risk prompts but never expands capability or root scope', () => {
  const root = path.resolve('C:\\Projects\\Mecord');
  const permissions: PermissionProfile = {
    allowedCapabilities: ['file.replace', 'docker.manage', 'browser.interact', 'app.operate', 'terminal.execute'],
    allowedRoots: [root],
    allowExternalWrites: false,
    allowSystemChanges: false,
    allowDestructive: false
  };
  const store = new SessionApprovalStore();
  const record: ApprovalRecord = {
    actionId: 'seed-session',
    actionHash: 'a'.repeat(64),
    authorityHash: approvalAuthorityFingerprint(undefined),
    approvalRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    capability: 'file.replace',
    risk: 'destructive',
    target: path.join(root, 'seed.txt'),
    status: 'approved',
    createdAt: new Date().toISOString(),
    pendingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedAt: new Date().toISOString(),
    approvalExpiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  store.grant(record, permissions);
  const granted = store.permissionsFor(undefined, permissions);
  assert.equal(granted.allowExternalWrites, true);
  assert.equal(granted.allowSystemChanges, true);
  assert.equal(granted.allowDestructive, true);

  const policy = new PolicyEngine();
  const inside: ActionRequest = {
    id: 'inside',
    capability: 'file.replace',
    risk: 'destructive',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'chatgpt' }
  };
  assert.doesNotThrow(() => policy.authorize(inside, granted));

  const outside: ActionRequest = {
    ...inside,
    id: 'outside',
    input: { path: path.resolve('C:\\Outside\\a.txt') }
  };
  assert.throws(() => policy.authorize(outside, granted), (error: any) => error?.code === 'PATH_OUTSIDE_SCOPE');

  const forbidden: ActionRequest = {
    id: 'forbidden',
    capability: 'git.checkpoint.restore',
    risk: 'destructive',
    input: {},
    provenance: { kind: 'chatgpt' }
  };
  assert.throws(() => policy.authorize(forbidden, granted), (error: any) => error?.code === 'CAPABILITY_DENIED');
});
