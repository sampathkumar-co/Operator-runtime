import assert from 'node:assert/strict';
import test from 'node:test';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';

test('Control Center exposes the R4 human-product surface plus Stage19/20 controls', () => {
  const html = renderControlCenter('nonce_test');
  for (const marker of [
    'data-tab="tasks">Home',
    'data-tab="approvals">Approvals',
    'data-tab="recovery">Recovery',
    'data-tab="onboarding">Onboarding',
    'data-tab="activity">Activity',
    'data-tab="devices">Devices',
    'data-tab="policies">Policies',
    'data-tab="knowledge">Knowledge',
    'data-tab="diagnostics">Diagnostics',
    'data-tab="studio">Studio',
    'data-tab="desired">Desired state',
    'id="approvalList"',
    'id="recoveryList"',
    'id="onboardingList"',
    'id="diagnosticList"',
    '/v1/control-center/approvals',
    '/v1/control-center/recovery?limit=100',
    '/v1/control-center/onboarding',
    '/v1/control-center/diagnostics',
    '/v1/enterprise-policy',
    '/v1/procedures',
    '/v1/world/entities',
    'role="tablist"',
    'aria-selected="true"',
    'role="status"',
    'id="studioWorkflowId"',
    'id="createStudioRun"',
    'id="desiredJson"',
    'id="createDesired"'
  ]) {
    assert.equal(html.includes(marker), true, `missing Control Center marker: ${marker}`);
  }
});

test('Control Center does not embed bearer or recovery authority in markup', () => {
  const html = renderControlCenter('nonce_test');
  assert.equal(html.includes('OPERATOR_AGENT_TOKEN'), false);
  assert.equal(html.includes('OPERATOR_RECOVERY_TOKEN'), false);
  assert.equal(html.includes('localStorage'), false);
  assert.equal(html.includes('sessionStorage'), false);
  assert.equal(html.includes('beforeunload'), true);
});

test('Control Center refreshes R4 truth from authenticated runtime APIs', () => {
  const html = renderControlCenter('nonce_test');
  for (const loader of [
    'loadTasks()',
    'loadApprovals()',
    'loadRecovery()',
    'loadOnboarding()',
    'loadActivity()',
    'loadDevices()',
    'loadPolicies()',
    'loadKnowledge()',
    'loadDiagnostics()'
  ]) {
    assert.equal(html.includes(loader), true, `missing refresh loader: ${loader}`);
  }
});
