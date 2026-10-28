import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlCenterRuntimeStatus } from '../src/core/control-center-runtime-status.ts';

const observedAt = '2026-10-28T12:00:00.000Z';
const base = {
  productVersion: '2.0.6', startedAt: '2026-10-28T11:00:00.000Z',
  observedAt, authorizedRootCount: 0, supportedCapabilities: []
};
const localSource = 'a'.repeat(40);
const remoteSource = 'b'.repeat(40);
function project(relay: Record<string, unknown>, sourceCommit: unknown = localSource) {
  return buildControlCenterRuntimeStatus({ ...base, runtimeStatus: {
    sourceCommit, packageVersion: '2.0.6', relay
  } });
}
test('C10 Control Center detects fresh relay source mismatch, never confused with package semver', () => {
  const relay = { state: 'READY', configured: true, required: true,
    updatedAt: observedAt, sourceCommit: remoteSource };
  const report = project(relay);
  assert.equal(report.product.compatibility, 'MATCH');
  assert.equal(report.relay.sourceCommit, remoteSource);
  assert.equal(report.relay.sourceCompatibility, 'MISMATCH');
  assert.equal(project({ ...relay, sourceCommit: localSource }).relay.sourceCompatibility, 'MATCH');
});
test('C10 unverified, disconnected, stale or malformed relay evidence cannot imply compatibility', () => {
  const live = { configured: true, state: 'READY', updatedAt: observedAt, sourceCommit: localSource };
  for (const candidate of [
    { ...live, sourceCommit: 'fake' },
    { ...live, sourceCommit: undefined },
    { ...live, state: 'OFFLINE' },
    { ...live, updatedAt: '2026-10-28T11:54:00.000Z' },
    { ...live, updatedAt: '2026-10-28T12:01:00.000Z' }
  ]) assert.equal(project(candidate).relay.sourceCompatibility, 'UNKNOWN');
  assert.equal(project(live, null).relay.sourceCompatibility, 'UNKNOWN');
  assert.equal(JSON.stringify(project({ ...live, bearer: 'secret-never-project' })).includes('secret-never-project'), false);
});
