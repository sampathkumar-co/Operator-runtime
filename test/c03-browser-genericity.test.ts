import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProductionBrowserGenericity, verifyCurrentSourceGenericity } from '../scripts/c03-browser-genericity.mjs';

const roster = { taskIds: Array.from({length:125},(_,i)=>
  'miniwob.click-example-test-' + String(i).padStart(3,'0')) };
function files() {
  return {
    'src/capabilities/browser-cdp.ts': 'export const safe = "generic click";',
    'src/capabilities/browser-cdp-connection.ts': 'export const safe = "generic tab";',
    'src/capabilities/browser-cdp-frames.ts': 'export const safe = "generic frame";',
    'src/capabilities/browser-cdp-page.ts': 'export const safe = "generic DOM";',
    'src/core/task-orchestrator.ts': 'export const safe = "generic planner";',
    'src/core/model-goal-proposal.ts': 'export const safe = "scope validated";',
    'src/core/reviewed-model-goal.ts': 'export const safe = "reviewed goal";',
    'apps/local-agent/src/runtime-factory.ts': 'export const safe = "registered providers";',
    'apps/mcp-server/src/public-tools.ts': 'export const safe = "public tools";'
  };
}
test('C03 real production browser code contains no frozen task IDs or special selectors', async () => {
  const report = await verifyCurrentSourceGenericity();
  assert.equal(report.status, 'SOURCE_GENERICITY_CHECK_PASSED');
  assert.equal(report.rosterCount, 125);
  assert.ok(report.browserSourceCount >= 4);
  assert.match(report.rosterDigest, /^[0-9a-f]{64}$/);
  assert.equal(report.releaseApproval, 'NOT_GRANTED');
  assert.equal(report.independentUserOutcome, 'NOT_RUN');
});
test('C03 injected fixture task name or benchmark-specific routing must fail source gate', () => {
  const literal = files();
  literal['src/capabilities/browser-cdp.ts'] = "if (id === 'click-example-test-007') click('#demo')";
  assert.throws(() => verifyProductionBrowserGenericity({files: literal,roster}),
    /hard-coded frozen benchmark task name/);
  const namespace = files();
  namespace['src/core/task-orchestrator.ts'] = 'import { scorer } from "BrowserGym";';
  assert.throws(() => verifyProductionBrowserGenericity({files:namespace,roster}),
    /benchmark-specific source reference/);
  const special = files();
  special['src/capabilities/browser-cdp-page.ts'] = 'const task = "miniwob.click-example-test-022"';
  assert.throws(() => verifyProductionBrowserGenericity({files:special,roster}),
    /benchmark-specific source reference/);
});
test('C03 incomplete source or altered 125 roster is never treated as independent proof', () => {
  const missing = files();
  delete missing['src/capabilities/browser-cdp-page.ts'];
  assert.throws(() => verifyProductionBrowserGenericity({files:missing,roster}),
    /browser production file census incomplete/);
  const wrong = {taskIds: roster.taskIds.slice(1)};
  assert.throws(() => verifyProductionBrowserGenericity({files:files(),roster:wrong}),
    /official 125-task/);
  const duplicated = {taskIds: Array.from({length:125},()=>'miniwob.click-example-test-007')};
  assert.throws(() => verifyProductionBrowserGenericity({files:files(),roster:duplicated}),
    /official 125-task/);
});
test('C03 fixed task scan is a strict source prohibition, not a completion or performance benchmark', () => {
  const report = verifyProductionBrowserGenericity({files:files(),roster});
  assert.equal(report.status,'SOURCE_GENERICITY_CHECK_PASSED');
  assert.equal(report.releaseApproval,'NOT_GRANTED');
  assert.equal(report.physicalBrowserCertification,'NOT_RUN_IN_THIS_SOURCE_GATE');
  assert.match(report.limitation,/cannot prove intent, performance/);
});
