export type PersistentDataCategory = 'activity' | 'tasks' | 'session-state' | 'device-identity' | 'pairing-state';
export type DataSensitivity = 'operational' | 'personal' | 'sensitive' | 'secret';
export type StoreConcurrency = 'SINGLE_PROCESS_ONLY' | 'PROCESS_LOCKED' | 'REVISION_CAS' | 'APPEND_ONLY_JOURNALED';

export interface PersistentDataEntry {
  id: string;
  owner: string;
  location: string;
  category: PersistentDataCategory;
  sensitivity: DataSensitivity;
  retention: string;
  deletion: 'privacy-category' | 'device-reset-only' | 'account-device-erasure';
  backup: 'include' | 'exclude-secret' | 'ephemeral';
  restore: 'required' | 'optional' | 'never';
  scope: 'device' | 'account' | 'conversation' | 'task';
  secretMaterial: 'none' | 'derived' | 'encrypted' | 'plaintext-token';
  participatesInDeletion: boolean;
  concurrency: StoreConcurrency;
}

const entry = (value: PersistentDataEntry): PersistentDataEntry => Object.freeze(value);

/** Authoritative local-runtime persistent-data registry. New durable stores must be added here. */
export const PERSISTENT_DATA_CATALOG: readonly PersistentDataEntry[] = Object.freeze([
  entry({ id: 'audit-active', owner: 'audit', location: 'audit.ndjson', category: 'activity', sensitivity: 'sensitive', retention: 'bounded-active-segment', deletion: 'privacy-category', backup: 'include', restore: 'optional', scope: 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: 'APPEND_ONLY_JOURNALED' }),
  entry({ id: 'audit-head', owner: 'audit', location: 'audit-head.json', category: 'activity', sensitivity: 'operational', retention: 'while-audit-exists', deletion: 'privacy-category', backup: 'include', restore: 'optional', scope: 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: 'PROCESS_LOCKED' }),
  entry({ id: 'audit-segments', owner: 'audit', location: 'audit-segments', category: 'activity', sensitivity: 'sensitive', retention: 'bounded-segments', deletion: 'privacy-category', backup: 'include', restore: 'optional', scope: 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: 'APPEND_ONLY_JOURNALED' }),
  ...[
    ['provider-learning', 'provider-learning.json'], ['execution-optimizer', 'execution-optimizer.json'], ['world-model', 'world-model.json'],
    ['perception-graph', 'perception-graph.json'], ['procedure-memory', 'verified-procedures.json'], ['evaluations', 'evaluations.json'],
    ['conversation-ledger', 'conversations']
  ].map(([id, location]) => entry({ id, owner: id, location, category: 'activity', sensitivity: 'personal', retention: 'subsystem-bounded', deletion: 'privacy-category', backup: 'include', restore: 'optional', scope: id === 'conversation-ledger' ? 'conversation' : 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: id === 'conversation-ledger' ? 'APPEND_ONLY_JOURNALED' : 'SINGLE_PROCESS_ONLY' })),
  ...[
    ['tasks', 'tasks'], ['task-leases', 'task-leases'], ['team-missions', 'team-missions'], ['team-locks', 'team-mission-locks'],
    ['action-journal', 'action-transitions.json'], ['action-results', 'action-results'], ['sagas', 'durable-sagas.json'],
    ['compensation', 'compensation-intents.json'], ['intent-registry', 'intent'], ['studio-teach', 'studio-teach.json'],
    ['studio-workflows', 'studio-workflows'], ['studio-runs', 'studio-runs.json'], ['events', 'events.json'],
    ['desired-state', 'desired-state.json'], ['digital-operations', 'digital-operations.json'], ['organization-programs', 'organization-programs.json'],
    ['semantic-migrations', 'semantic-migrations.json']
  ].map(([id, location]) => entry({ id, owner: id, location, category: 'tasks', sensitivity: 'sensitive', retention: 'terminal-retention-or-archive', deletion: 'privacy-category', backup: 'include', restore: id.includes('lock') || id.includes('lease') ? 'never' : 'optional', scope: id === 'tasks' || id === 'task-leases' ? 'task' : 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: id.includes('lock') || id.includes('lease') ? 'PROCESS_LOCKED' : id === 'action-journal' || id === 'compensation' ? 'APPEND_ONLY_JOURNALED' : 'SINGLE_PROCESS_ONLY' })),
  ...[
    ['relay-client', 'relay-client.json', 'derived'], ['relay-session-credential', 'relay-session-credential.json', 'encrypted'],
    ['relay-session-token', 'relay-session.token', 'plaintext-token'], ['device-sessions', 'device-sessions.json', 'encrypted'],
    ['approvals', 'approvals.json', 'derived'], ['action-executions', 'action-executions.json', 'derived'],
    ['resource-leases', 'resource-leases.json', 'none'], ['emergency-stop', 'emergency-stop.json', 'none']
  ].map(([id, location, secretMaterial]) => entry({ id, owner: id, location, category: 'session-state', sensitivity: secretMaterial === 'plaintext-token' || secretMaterial === 'encrypted' ? 'secret' : 'sensitive', retention: 'active-session-or-policy', deletion: 'privacy-category', backup: secretMaterial === 'plaintext-token' ? 'exclude-secret' : 'include', restore: secretMaterial === 'plaintext-token' ? 'never' : 'optional', scope: 'device', secretMaterial: secretMaterial as PersistentDataEntry['secretMaterial'], participatesInDeletion: true, concurrency: id === 'resource-leases' ? 'PROCESS_LOCKED' : 'SINGLE_PROCESS_ONLY' })),
  entry({ id: 'device-identity', owner: 'device-identity', location: 'device-identity.json', category: 'device-identity', sensitivity: 'secret', retention: 'device-lifetime', deletion: 'device-reset-only', backup: 'exclude-secret', restore: 'never', scope: 'device', secretMaterial: 'encrypted', participatesInDeletion: true, concurrency: 'SINGLE_PROCESS_ONLY' }),
  ...[
    ['device-registry', 'device-registry.json'], ['device-routing', 'device-routing.json'], ['device-pool', 'device-pool.json'],
    ['device-enrollments', 'device-enrollments.json'], ['device-resets', 'device-resets.json'], ['account-devices', 'account-devices.json'],
    ['enterprise-policy', 'enterprise-policy.json'], ['bootstrap', 'bootstrap.json'], ['local-device-reset', 'local-device-reset.json']
  ].map(([id, location]) => entry({ id, owner: id, location, category: 'pairing-state', sensitivity: 'sensitive', retention: 'account-or-device-lifetime', deletion: 'account-device-erasure', backup: 'include', restore: id === 'device-registry' || id === 'account-devices' ? 'required' : 'optional', scope: id === 'account-devices' ? 'account' : 'device', secretMaterial: 'derived', participatesInDeletion: true, concurrency: id === 'account-devices' ? 'PROCESS_LOCKED' : 'SINGLE_PROCESS_ONLY' }))
]);

export function persistentDataForCategory(category: PersistentDataCategory): PersistentDataEntry[] {
  return PERSISTENT_DATA_CATALOG.filter((item) => item.category === category).map((item) => ({ ...item }));
}

export function validatePersistentDataCatalog(): void {
  const ids = new Set<string>();
  const locations = new Set<string>();
  for (const item of PERSISTENT_DATA_CATALOG) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id) || ids.has(item.id)) throw new Error('Persistent data catalog has an invalid or duplicate id.');
    if (!item.location || item.location.includes('\\') || item.location.startsWith('/') || item.location.split('/').includes('..') || locations.has(item.location)) {
      throw new Error('Persistent data catalog has an invalid or duplicate location.');
    }
    ids.add(item.id);
    locations.add(item.location);
  }
}
