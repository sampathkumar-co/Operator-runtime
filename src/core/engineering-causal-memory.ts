import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { ControlPlaneStore } from './control-plane-store.ts';
import { OperatorError } from './errors.ts';
import { engineeringObjectiveNamespace } from './engineering-objective-lifecycle.ts';

export type EngineeringMemoryKind =
  | 'objective' | 'authority' | 'plan' | 'observation' | 'action'
  | 'verification' | 'artifact' | 'incident' | 'learning';

export interface EngineeringCausalMemory {
  schemaVersion: 1;
  id: string;
  objectiveId: string;
  kind: EngineeringMemoryKind;
  payloadDigest: string;
  parentIds: string[];
  evidenceIds: string[];
  provenance: {
    actorId: string;
    system: string;
    sourceDigest: string;
  };
  valid: boolean;
  invalidatedAt?: string;
  invalidationReason?: string;
  createdAt: string;
  digest: string;
}

const NAMESPACE = engineeringObjectiveNamespace();
const MAX_MEMORY = 100_000;

export class EngineeringCausalMemoryStore {
  #store: ControlPlaneStore;
  #clock: () => Date;

  constructor(store: ControlPlaneStore, options: { clock?: () => Date } = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
  }

  async append(input: {
    id: string;
    objectiveId: string;
    kind: EngineeringMemoryKind;
    payloadDigest: string;
    parentIds?: string[];
    evidenceIds?: string[];
    provenance: EngineeringCausalMemory['provenance'];
  }): Promise<EngineeringCausalMemory> {
    const objectiveId = validId(input.objectiveId, 'objectiveId');
    const objective = await this.#store.get(NAMESPACE, 'objective:' + objectiveId);
    if (!objective) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', 'Causal memory objective does not exist.');

    const parentIds = idList(input.parentIds ?? [], 1000, 'parentIds');
    for (const parentId of parentIds) {
      const parent = await this.#store.get(NAMESPACE, memoryKey(parentId));
      if (!parent) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', 'Causal memory parent does not exist.');
      const normalized = normalizeEngineeringMemory(parent.value);
      if (normalized.objectiveId !== objectiveId || !normalized.valid) {
        throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', 'Causal memory parent is invalid or belongs to another objective.');
      }
    }

    const createdAt = this.#clock().toISOString();
    const body = {
      schemaVersion: 1 as const,
      id: validId(input.id, 'memory id'),
      objectiveId,
      kind: validKind(input.kind),
      payloadDigest: digest(input.payloadDigest, 'payloadDigest'),
      parentIds,
      evidenceIds: digestList(input.evidenceIds ?? [], 10_000, 'evidenceIds'),
      provenance: {
        actorId: validId(input.provenance?.actorId, 'provenance.actorId'),
        system: validId(input.provenance?.system, 'provenance.system'),
        sourceDigest: digest(input.provenance?.sourceDigest, 'provenance.sourceDigest')
      },
      valid: true as const,
      createdAt
    };
    const memory: EngineeringCausalMemory = { ...body, digest: hash(body) };
    await this.#store.transact([{
      namespace: NAMESPACE,
      key: memoryKey(memory.id),
      expectedGeneration: null,
      value: memory as unknown as Record<string, unknown>
    }], createdAt);
    return memory;
  }

  async get(idInput: string): Promise<EngineeringCausalMemory | null> {
    const record = await this.#store.get(NAMESPACE, memoryKey(validId(idInput, 'memory id')));
    return record ? normalizeEngineeringMemory(record.value) : null;
  }

  async listObjective(objectiveIdInput: string): Promise<EngineeringCausalMemory[]> {
    const objectiveId = validId(objectiveIdInput, 'objectiveId');
    return (await this.#store.list(NAMESPACE))
      .filter((record) => record.key.startsWith('memory:'))
      .slice(0, MAX_MEMORY)
      .map((record) => normalizeEngineeringMemory(record.value))
      .filter((memory) => memory.objectiveId === objectiveId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async invalidate(idInput: string, reasonInput: string): Promise<EngineeringCausalMemory[]> {
    const rootId = validId(idInput, 'memory id');
    const reason = boundedText(reasonInput, 4096, 'reason');
    const all = (await this.#store.list(NAMESPACE))
      .filter((record) => record.key.startsWith('memory:'))
      .slice(0, MAX_MEMORY)
      .map((record) => ({ record, memory: normalizeEngineeringMemory(record.value) }));
    const byId = new Map(all.map((entry) => [entry.memory.id, entry]));
    if (!byId.has(rootId)) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_NOT_FOUND', 'Causal memory entry was not found.');

    const affected = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of all) {
        if (affected.has(entry.memory.id)) continue;
        if (entry.memory.parentIds.some((parentId) => affected.has(parentId))) {
          affected.add(entry.memory.id);
          changed = true;
        }
      }
    }

    const now = this.#clock().toISOString();
    const updates = [...affected].sort().map((memoryId) => {
      const entry = byId.get(memoryId)!;
      const memory: EngineeringCausalMemory = {
        ...entry.memory,
        valid: false,
        invalidatedAt: now,
        invalidationReason: reason
      };
      return { entry, memory };
    });
    await this.#store.transact(updates.map(({ entry, memory }) => ({
      namespace: NAMESPACE,
      key: entry.record.key,
      expectedGeneration: entry.record.generation,
      value: memory as unknown as Record<string, unknown>
    })), now);
    return updates.map(({ memory }) => memory);
  }

  async assertUsable(idsInput: string[]): Promise<void> {
    for (const memoryId of idList(idsInput, 10_000, 'memoryIds')) {
      const record = await this.#store.get(NAMESPACE, memoryKey(memoryId));
      if (!record || !normalizeEngineeringMemory(record.value).valid) {
        throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALIDATED', 'A referenced causal memory entry is absent or invalidated.');
      }
    }
  }
}

export function normalizeEngineeringMemory(input: Record<string, unknown>): EngineeringCausalMemory {
  const base = {
    schemaVersion: 1 as const,
    id: validId(input.id, 'memory id'),
    objectiveId: validId(input.objectiveId, 'objectiveId'),
    kind: validKind(input.kind),
    payloadDigest: digest(input.payloadDigest, 'payloadDigest'),
    parentIds: idList(input.parentIds ?? [], 1000, 'parentIds'),
    evidenceIds: digestList(input.evidenceIds ?? [], 10_000, 'evidenceIds'),
    provenance: {
      actorId: validId((input.provenance as Record<string, unknown>)?.actorId, 'provenance.actorId'),
      system: validId((input.provenance as Record<string, unknown>)?.system, 'provenance.system'),
      sourceDigest: digest((input.provenance as Record<string, unknown>)?.sourceDigest, 'provenance.sourceDigest')
    },
    valid: input.valid === true,
    createdAt: canonicalIso(input.createdAt, 'createdAt')
  };
  const originalBody = { ...base, valid: true as const };
  const actualDigest = digest(input.digest, 'memory.digest');
  if (hash(originalBody) !== actualDigest) {
    throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_CORRUPT', 'Causal memory digest does not match its immutable provenance body.');
  }
  if (base.valid && (input.invalidatedAt || input.invalidationReason)) {
    throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_CORRUPT', 'Valid causal memory contains invalidation metadata.');
  }
  return {
    ...base,
    ...(input.invalidatedAt ? { invalidatedAt: canonicalIso(input.invalidatedAt, 'invalidatedAt') } : {}),
    ...(input.invalidationReason ? { invalidationReason: boundedText(input.invalidationReason, 4096, 'invalidationReason') } : {}),
    digest: actualDigest
  };
}

export function causalMemoryDigest(memories: EngineeringCausalMemory[]): string {
  const normalized = memories.map((memory) => normalizeEngineeringMemory(memory as unknown as Record<string, unknown>))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hash(normalized.map((memory) => ({
    id: memory.id,
    objectiveId: memory.objectiveId,
    digest: memory.digest,
    valid: memory.valid,
    invalidatedAt: memory.invalidatedAt ?? null
  })));
}

function memoryKey(id: string): string { return 'memory:' + id; }
function validKind(value: unknown): EngineeringMemoryKind {
  const kind = String(value ?? '') as EngineeringMemoryKind;
  if (!['objective', 'authority', 'plan', 'observation', 'action', 'verification', 'artifact', 'incident', 'learning'].includes(kind)) {
    throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', 'Memory kind is invalid.');
  }
  return kind;
}
function validId(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(text)) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' is invalid.');
  return text;
}
function idList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' is invalid.');
  return [...new Set(value.map((item) => validId(item, label)))].sort();
}
function digestList(value: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' is invalid.');
  return [...new Set(value.map((item) => digest(item, label)))].sort();
}
function boundedText(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' is invalid.');
  }
  return value;
}
function digest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' must be SHA-256.');
  return text;
}
function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new OperatorError('ENGINEERING_CAUSAL_MEMORY_INVALID', label + ' must be canonical ISO.');
  }
  return text;
}
function hash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
