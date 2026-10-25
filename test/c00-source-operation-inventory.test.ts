import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { buildC00SourceInventory } from '../scripts/c00-source-operation-inventory.ts';

test('C00 inventories every canonical operation and registered provider without claiming execution', async () => {
  const report = await buildC00SourceInventory();
  assert.match(report.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(report.declaredCanonicalCapabilityCount, Object.keys(CAPABILITY_RISK_RULES).length);
  assert.equal(report.operations.length, Object.keys(CAPABILITY_RISK_RULES).length);
  assert.ok(report.providerRegistrationCount >= 15);
  assert.equal(report.providerRegistration.length, report.providerRegistrationCount);
  assert.ok(report.scannedTestFileCount > 100);
  assert.equal(new Set(report.operations.map(item => item.capability)).size, report.operations.length);
  assert.ok(report.operations.every(item => item.perOperationOutputVerification === 'NOT_CERTIFIED_BY_SOURCE_INVENTORY'
    && item.authorizationAndUserOutcome === 'NOT_TESTED'
    && item.actualOsSupport === 'NOT_PHYSICALLY_VERIFIED'));
  assert.equal(report.releaseAcceptance, 'NOT_ACCEPTED');
});
test('C00 risk and test source references are provenance hints, not fake runtime support', async () => {
  const report = await buildC00SourceInventory();
  const status = report.operations.find(item => item.capability === 'git.status')!;
  assert.equal(status.canonicalRisk, 'read');
  assert.ok(status.sourceTestHints.length > 0);
  assert.ok(status.sourceTestHints.every(hint => hint.startsWith('..') === false && hint.endsWith('.test.ts')));
  const dynamic = report.operations.find(item => item.capability === 'file.manage')!;
  assert.equal(dynamic.canonicalRisk, 'dynamic');
  assert.equal(dynamic.riskResolution, 'TYPED_OPERATION_AND_FRESH_AUTHORITY_REQUIRED');
  assert.ok(report.providerRegistration.every(p => p.sourcePlatformLimitation.includes('NOT_TESTED') || p.sourcePlatformLimitation.includes('NOT_VERIFIED')));
});
