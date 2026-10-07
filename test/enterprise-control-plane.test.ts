import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPurposeBoundAuthorityLeaseUsable,
  compareEnterprisePolicySimulation,
  createEnterpriseIdentityMapping,
  createOrganizationEmergencyState,
  issuePurposeBoundAuthorityLease,
  transitionOrganizationEmergencyState
} from '../src/core/enterprise-control-plane.ts';

const parent = {
  capabilities: ['git.*', 'filesystem.read'],
  resourcePrefixes: ['repo/acme'],
  maxRisk: 'destructive' as const,
  expiresAt: '2026-10-08T00:00:00.000Z'
};

test('enterprise identity mapping is deterministic and bounded', () => {
  const left = createEnterpriseIdentityMapping({
    provider: 'oidc',
    externalSubject: 'user-123',
    principalId: 'principal:alice',
    groups: ['eng', 'release'],
    observedAt: '2026-10-07T00:00:00.000Z'
  });
  const right = createEnterpriseIdentityMapping({
    provider: 'oidc',
    externalSubject: 'user-123',
    principalId: 'principal:alice',
    groups: ['release', 'eng'],
    observedAt: '2026-10-07T00:00:00.000Z'
  });
  assert.equal(left.id, right.id);
  assert.deepEqual(left.groups, ['eng', 'release']);
});

test('purpose-bound lease attenuates authority and enforces separation of duties', () => {
  const emergency = createOrganizationEmergencyState({
    organizationId: 'org:acme',
    epoch: 7,
    changedAt: '2026-10-07T00:00:00.000Z'
  });
  const lease = issuePurposeBoundAuthorityLease({
    organizationId: 'org:acme',
    principalId: 'agent:builder',
    delegationId: 'delegation:build',
    purpose: 'Build and verify release candidate',
    parentGrant: parent,
    grant: {
      capabilities: ['git.commit'],
      resourcePrefixes: ['repo/acme/service'],
      maxRisk: 'system',
      expiresAt: '2026-10-07T02:00:00.000Z'
    },
    emergencyState: emergency,
    approverPrincipalIds: ['human:alice', 'human:bob'],
    requiredApprovalQuorum: 2,
    issuedAt: '2026-10-07T00:00:00.000Z',
    expiresAt: '2026-10-07T01:00:00.000Z'
  });
  const path = assertPurposeBoundAuthorityLeaseUsable({
    lease,
    emergencyState: emergency,
    now: '2026-10-07T00:30:00.000Z',
    capability: 'git.commit',
    resource: 'repo/acme/service/src',
    risk: 'system'
  });
  assert.equal(path.principalId, 'agent:builder');
  assert.equal(path.emergencyEpoch, 7);
  assert.match(path.authorityDigest, /^[0-9a-f]{64}$/);

  assert.throws(() => issuePurposeBoundAuthorityLease({
    organizationId: 'org:acme',
    principalId: 'agent:builder',
    delegationId: 'delegation:bad',
    purpose: 'Expand authority',
    parentGrant: parent,
    grant: {
      capabilities: ['process.manage'],
      resourcePrefixes: ['repo'],
      maxRisk: 'destructive'
    },
    emergencyState: emergency,
    approverPrincipalIds: ['human:alice', 'human:bob'],
    issuedAt: '2026-10-07T00:00:00.000Z',
    expiresAt: '2026-10-07T01:00:00.000Z'
  }), /expands capability authority|expands resource authority/);
});

test('emergency epoch invalidates all previously issued leases', () => {
  const emergency = createOrganizationEmergencyState({
    organizationId: 'org:acme',
    epoch: 2,
    changedAt: '2026-10-07T00:00:00.000Z'
  });
  const lease = issuePurposeBoundAuthorityLease({
    organizationId: 'org:acme',
    principalId: 'agent:reader',
    delegationId: 'delegation:read',
    purpose: 'Inspect source',
    parentGrant: { capabilities: ['filesystem.read'], resourcePrefixes: ['repo/acme'], maxRisk: 'read' },
    grant: { capabilities: ['filesystem.read'], resourcePrefixes: ['repo/acme'], maxRisk: 'read' },
    emergencyState: emergency,
    issuedAt: '2026-10-07T00:00:00.000Z',
    expiresAt: '2026-10-07T00:20:00.000Z'
  });
  const halted = transitionOrganizationEmergencyState(emergency, {
    halted: true,
    changedAt: '2026-10-07T00:05:00.000Z',
    reasonCode: 'SECURITY_INCIDENT'
  });
  assert.throws(() => assertPurposeBoundAuthorityLeaseUsable({
    lease,
    emergencyState: halted,
    now: '2026-10-07T00:06:00.000Z'
  }), /emergency halt/);
  const resumed = transitionOrganizationEmergencyState(halted, {
    halted: false,
    changedAt: '2026-10-07T00:10:00.000Z'
  });
  assert.throws(() => assertPurposeBoundAuthorityLeaseUsable({
    lease,
    emergencyState: resumed,
    now: '2026-10-07T00:11:00.000Z'
  }), /predates the current organization emergency epoch/);
});

test('policy rollout comparison exposes newly allowed and denied actions', () => {
  const before = [
    { id: 'a', allowed: false, roleIds: [], bindingIds: [], deniedCode: 'DENIED' },
    { id: 'b', allowed: true, roleIds: ['r'], bindingIds: ['x'] },
    { id: 'c', allowed: false, roleIds: [], bindingIds: [], deniedCode: 'OLD' }
  ];
  const after = [
    { id: 'a', allowed: true, roleIds: ['r'], bindingIds: ['x'] },
    { id: 'b', allowed: false, roleIds: [], bindingIds: [], deniedCode: 'DENIED' },
    { id: 'c', allowed: false, roleIds: [], bindingIds: [], deniedCode: 'NEW' }
  ];
  const delta = compareEnterprisePolicySimulation(before, after);
  assert.deepEqual(delta.newlyAllowed, ['a']);
  assert.deepEqual(delta.newlyDenied, ['b']);
  assert.deepEqual(delta.changedDenialCode, ['c']);
  assert.equal(delta.unchanged, 0);
});
