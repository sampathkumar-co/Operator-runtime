import assert from 'node:assert/strict';
import test from 'node:test';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';

test('Control Center exposes Stage19 Studio and Stage20 desired-state surfaces', () => {
  const html = renderControlCenter('nonce_test');
  for (const marker of [
    'data-tab="studio"',
    'data-tab="desired"',
    'id="studioWorkflowId"',
    'id="createStudioRun"',
    'id="studioList"',
    'id="desiredJson"',
    'id="createDesired"',
    'id="desiredList"',
    '/v1/studio/runs?limit=100',
    '/v1/studio/workflows/',
    '/v1/desired-state?limit=100',
    '/v1/desired-state/'
  ]) {
    assert.equal(html.includes(marker), true, `missing Control Center marker: ${marker}`);
  }
  assert.equal(html.includes('Promise.all([loadTasks(),loadTeams(),loadStudioRuns(),loadDesired()])'), true);
});
