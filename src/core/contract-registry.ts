export type ContractCompatibility = 'exact' | 'backward-readable';

export interface ContractRegistration {
  name: string;
  schemaVersion: number;
  persistent: boolean;
  compatibility: ContractCompatibility;
  owner: 'runtime' | 'release' | 'evaluation';
}

export const CONTRACT_REGISTRY = Object.freeze([
  { name: 'release-truth', schemaVersion: 1, persistent: true, compatibility: 'exact', owner: 'release' },
  { name: 'intent-binding', schemaVersion: 1, persistent: true, compatibility: 'exact', owner: 'runtime' },
  { name: 'task-capsule', schemaVersion: 1, persistent: true, compatibility: 'backward-readable', owner: 'runtime' },
  { name: 'durable-task-plan', schemaVersion: 1, persistent: true, compatibility: 'backward-readable', owner: 'runtime' },
  { name: 'execution-context-identity', schemaVersion: 1, persistent: true, compatibility: 'exact', owner: 'runtime' },
  { name: 'evaluation-state', schemaVersion: 1, persistent: true, compatibility: 'backward-readable', owner: 'evaluation' },
  { name: 'action-request', schemaVersion: 1, persistent: false, compatibility: 'exact', owner: 'runtime' },
  { name: 'evidence', schemaVersion: 1, persistent: true, compatibility: 'backward-readable', owner: 'runtime' }
] satisfies readonly ContractRegistration[]);

export function contractRegistration(name: string): ContractRegistration {
  const found = CONTRACT_REGISTRY.find((item) => item.name === name);
  if (!found) throw new Error(`Unknown contract: ${name}`);
  return found;
}

export function assertContractRegistryValid(): void {
  const names = new Set<string>();
  for (const item of CONTRACT_REGISTRY) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(item.name)) throw new Error(`Invalid contract name: ${item.name}`);
    if (names.has(item.name)) throw new Error(`Duplicate contract registration: ${item.name}`);
    names.add(item.name);
    if (!Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < 1) {
      throw new Error(`Invalid schema version for contract: ${item.name}`);
    }
  }
}
