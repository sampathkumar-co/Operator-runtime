import assert from 'node:assert/strict';
import test from 'node:test';
import { readControlCenterAsset, renderControlCenter } from '../apps/local-agent/src/control-center.ts';

test('Control Center preserves Stage19 Studio and Stage20 desired-state surfaces after R4 frontend split', () => {
  const html = renderControlCenter();
  const app = readControlCenterAsset('app.js');
  for (const marker of [
    'data-tab="studio"',
    'data-tab="desired"',
    'id="studioWorkflowId"',
    'id="createStudioRun"',
    'id="studioList"',
    'id="desiredJson"',
    'id="createDesired"',
    'id="desiredList"'
  ]) {
    assert.equal(html.includes(marker), true, `missing Control Center HTML marker: ${marker}`);
  }
  for (const marker of [
    '/v1/studio/runs?limit=100',
    '/v1/studio/workflows/',
    '/v1/desired-state?limit=100',
    '/v1/desired-state/'
  ]) {
    assert.equal(app.includes(marker), true, `missing Control Center application marker: ${marker}`);
  }
});
