import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSISTENT_DATA_CATALOG, persistentDataForCategory, validatePersistentDataCatalog } from '../src/core/persistent-data-catalog.ts';

test('persistent data catalog is unique and covers execution, learning, identity, and privacy state', () => {
  assert.doesNotThrow(() => validatePersistentDataCatalog());
  const ids = new Set(PERSISTENT_DATA_CATALOG.map((item) => item.id));
  for (const required of [
    'audit-active', 'relay-session-credential', 'action-journal', 'action-results', 'sagas', 'compensation',
    'intent-registry', 'world-model', 'procedure-memory', 'studio-teach', 'team-missions', 'evaluations',
    'approvals', 'device-identity', 'device-registry'
  ]) assert.ok(ids.has(required), required);
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.concurrency.length > 0));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.retention.length > 0));
  assert.ok(PERSISTENT_DATA_CATALOG.every((item) => item.restore.length > 0));
});

test('privacy categories are catalog-derived and exclude protected device authority', () => {
  const deletable = ['activity', 'tasks', 'session-state'].flatMap((category) => persistentDataForCategory(category as any));
  assert.ok(deletable.length > 20);
  assert.ok(deletable.every((item) => item.deletion === 'privacy-category' && item.participatesInDeletion));
  assert.equal(deletable.some((item) => item.id === 'device-identity'), false);
});
