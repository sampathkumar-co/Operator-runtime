import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PERSISTENT_DATA_CATALOG, assertPersistentDataLocationsCataloged, persistentDataForCategory, validatePersistentDataCatalog } from '../src/core/persistent-data-catalog.ts';

test('persistent data catalog is unique and covers execution, learning, identity, and privacy state', () => {
  assert.doesNotThrow(() => validatePersistentDataCatalog());
  const ids = new Set(PERSISTENT_DATA_CATALOG.map((item) => item.id));
  for (const required of [
    'audit-active', 'audit-freshness', 'relay-session-credential', 'action-journal', 'action-results', 'sagas', 'compensation',
    'intent-registry', 'world-model', 'procedure-memory', 'studio-teach', 'team-missions', 'evaluations',
    'approvals', 'device-identity', 'device-registry', 'enterprise-authority-leases', 'enterprise-identity'
  ]) assert.ok(ids.has(required), required);
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.concurrency.length > 0));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.retention.length > 0));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => Object.values(item.lifecycle).every((description) => description.length >= 12)));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.lifecycle.corruptionBehavior.includes('fail closed')));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.lifecycle.restartBehavior.length > 20));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.restore.length > 0));
  const auditFreshness = PERSISTENT_DATA_CATALOG.find((item) => item.id === 'audit-freshness')!;
  assert.equal(auditFreshness.restore, 'never');
  assert.notEqual(auditFreshness.backup, 'include');
});

test('source-declared durable store locations are automatically covered by the authoritative catalog', async () => {
  const roots = [path.resolve('src/core'), path.resolve('apps/local-agent/src')];
  const files: string[] = [];
  for (const root of roots) {
    for (const name of await fs.readdir(root)) if (name.endsWith('.ts')) files.push(path.join(root, name));
  }
  const discovered = new Set<string>();
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/this\.#(?:file|stateFile|freshnessFile|journalFile|resultDir|segmentDir|workflowDir|dir|leaseDir|lockDir|lockFile|outbox)\s*=\s*path\.join\([^;\n]*?['"]([^'"]+)['"]/g)) {
      discovered.add(match[1]!);
    }
    for (const match of source.matchAll(/(?:lockPath|relayTokenFile)\s*=\s*(?:path\.resolve\([^\n]*?)?path\.join\([^;\n]*?['"]([^'"]+)['"]/g)) {
      discovered.add(match[1]!);
    }
  }
  assert.ok(discovered.size > 35, `expected broad automatic store discovery, got ${discovered.size}`);
  assert.doesNotThrow(() => assertPersistentDataLocationsCataloged(discovered));
});

test('privacy categories are catalog-derived and exclude protected device authority', () => {
  const deletable = ['activity', 'tasks', 'session-state'].flatMap((category) => persistentDataForCategory(category as any)).filter((item) => item.participatesInDeletion);
  assert.ok(deletable.length > 20);
  assert.ok(deletable.every((item) => item.deletion === 'privacy-category' && item.participatesInDeletion));
  assert.equal(deletable.some((item) => item.id === 'device-identity'), false);
});
