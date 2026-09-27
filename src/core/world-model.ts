import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

const MAX_ENTITIES = 20_000;
const MAX_RELATIONS = 50_000;
const MAX_FACTS_PER_ENTITY = 200;
const MAX_CLAIMS_PER_FACT = 20;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_FACT_BYTES = 32 * 1024;
const MAX_TTL_MS = 30 * 24 * 60 * 60_000;
const MIN_TTL_MS = 5_000;
const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|private.?key|api.?key)/i;

export type WorldDomain = 'browser' | 'application' | 'filesystem' | 'git' | 'database' | 'process' | 'device' | 'project' | 'organization' | 'other';

export interface WorldClaim {
  id: string;
  source: string;
  domain: WorldDomain;
  evidenceDigest: string;
  value: unknown;
  valueDigest: string;
  confidence: number;
  observedAt: string;
  expiresAt: string;
}

export interface WorldFact {
  key: string;
  claims: WorldClaim[];
}

export interface WorldEntity {
  id: string;
  key: string;
  type: string;
  scopeKey: string;
  label: string;
  facts: WorldFact[];
  createdAt: string;
  updatedAt: string;
}

export interface WorldRelation {
  id: string;
  fromKey: string;
  toKey: string;
  type: string;
  source: string;
  domain: WorldDomain;
  evidenceDigest: string;
  confidence: number;
  observedAt: string;
  expiresAt: string;
}

interface WorldModelState {
  version: 1;
  entities: WorldEntity[];
  relations: WorldRelation[];
}

export interface ResolvedWorldFact {
  entityKey: string;
  factKey: string;
  status: 'resolved' | 'conflict' | 'missing';
  value?: unknown;
  confidence?: number;
  claims: WorldClaim[];
}

const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'WORLD_MODEL_CORRUPT',
  invalidMessage: 'World model state is invalid.'
} as const;

export class WorldModelStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'world-model.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async observe(input: {
    entity: { key: string; type: string; scopeKey: string; label: string };
    source: string;
    domain: WorldDomain;
    evidenceDigest: string;
    facts?: Record<string, unknown>;
    relations?: Array<{ type: string; toKey: string; confidence?: number }>;
    confidence?: number;
    ttlMs?: number;
  }): Promise<WorldEntity> {
    const normalized = normalizeObservation(input);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      const nowIso = now.toISOString();
      pruneExpired(state, now.getTime());
      let entity = state.entities.find((item) => item.key === normalized.entity.key);
      if (!entity) {
        if (state.entities.length >= MAX_ENTITIES) throw new OperatorError('WORLD_MODEL_LIMIT', 'World entity limit reached.');
        entity = {
          id: crypto.randomUUID(),
          key: normalized.entity.key,
          type: normalized.entity.type,
          scopeKey: normalized.entity.scopeKey,
          label: normalized.entity.label,
          facts: [],
          createdAt: nowIso,
          updatedAt: nowIso
        };
        state.entities.push(entity);
      } else {
        if (entity.type !== normalized.entity.type || entity.scopeKey !== normalized.entity.scopeKey) {
          throw new OperatorError('WORLD_ENTITY_IDENTITY_CONFLICT', 'Existing world entity key has a different type or scope.');
        }
        entity.label = normalized.entity.label;
        entity.updatedAt = nowIso;
      }

      for (const [factKey, value] of Object.entries(normalized.facts)) {
        let fact = entity.facts.find((item) => item.key === factKey);
        if (!fact) {
          if (entity.facts.length >= MAX_FACTS_PER_ENTITY) throw new OperatorError('WORLD_FACT_LIMIT', 'World entity fact limit reached.');
          fact = { key: factKey, claims: [] };
          entity.facts.push(fact);
        }
        const valueDigest = digestJson(value);
        const sameSource = fact.claims.find((claim) => claim.source === normalized.source && claim.domain === normalized.domain);
        const claim: WorldClaim = {
          id: sameSource?.id ?? crypto.randomUUID(),
          source: normalized.source,
          domain: normalized.domain,
          evidenceDigest: normalized.evidenceDigest,
          value: structuredClone(value),
          valueDigest,
          confidence: normalized.confidence,
          observedAt: nowIso,
          expiresAt: new Date(now.getTime() + normalized.ttlMs).toISOString()
        };
        if (sameSource) Object.assign(sameSource, claim);
        else {
          if (fact.claims.length >= MAX_CLAIMS_PER_FACT) {
            fact.claims.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
            fact.claims.shift();
          }
          fact.claims.push(claim);
        }
        fact.claims.sort((a, b) => a.source.localeCompare(b.source) || a.domain.localeCompare(b.domain));
      }
      entity.facts.sort((a, b) => a.key.localeCompare(b.key));

      for (const relation of normalized.relations) {
        if (!state.entities.some((candidate) => candidate.key === relation.toKey)) {
          // Relations may point at entities that have not been observed yet. They
          // remain explicit unresolved graph edges rather than inventing entity data.
        }
        const existing = state.relations.find((item) =>
          item.fromKey === entity!.key && item.toKey === relation.toKey && item.type === relation.type &&
          item.source === normalized.source && item.domain === normalized.domain
        );
        const next: WorldRelation = {
          id: existing?.id ?? crypto.randomUUID(),
          fromKey: entity.key,
          toKey: relation.toKey,
          type: relation.type,
          source: normalized.source,
          domain: normalized.domain,
          evidenceDigest: normalized.evidenceDigest,
          confidence: relation.confidence,
          observedAt: nowIso,
          expiresAt: new Date(now.getTime() + normalized.ttlMs).toISOString()
        };
        if (existing) Object.assign(existing, next);
        else {
          if (state.relations.length >= MAX_RELATIONS) throw new OperatorError('WORLD_RELATION_LIMIT', 'World relation limit reached.');
          state.relations.push(next);
        }
      }

      state.entities.sort((a, b) => a.key.localeCompare(b.key));
      state.relations.sort((a, b) => relationIdentity(a).localeCompare(relationIdentity(b)));
      await this.#write(state);
      return structuredClone(entity);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async resolveFact(entityKeyInput: string, factKeyInput: string): Promise<ResolvedWorldFact> {
    await this.#serial;
    const state = await this.#read();
    const now = this.#clock().getTime();
    const entityKey = boundedContext(entityKeyInput, 'entityKey');
    const factKey = boundedKey(factKeyInput, 'factKey');
    const entity = state.entities.find((item) => item.key === entityKey);
    const fact = entity?.facts.find((item) => item.key === factKey);
    const claims = (fact?.claims ?? []).filter((claim) => Date.parse(claim.expiresAt) > now)
      .sort((a, b) => b.confidence - a.confidence || b.observedAt.localeCompare(a.observedAt));
    if (claims.length === 0) return { entityKey, factKey, status: 'missing', claims: [] };
    const byDigest = new Map<string, WorldClaim[]>();
    for (const claim of claims) {
      const group = byDigest.get(claim.valueDigest) ?? [];
      group.push(claim);
      byDigest.set(claim.valueDigest, group);
    }
    if (byDigest.size === 1) {
      const best = claims[0]!;
      return { entityKey, factKey, status: 'resolved', value: structuredClone(best.value), confidence: combinedConfidence(claims), claims: structuredClone(claims) };
    }
    const groups = [...byDigest.values()].sort((a, b) => combinedConfidence(b) - combinedConfidence(a));
    const first = groups[0]!;
    const second = groups[1]!;
    const firstScore = combinedConfidence(first);
    const secondScore = combinedConfidence(second);
    if (firstScore >= 0.9 && firstScore - secondScore >= 0.2 && first.length >= 2) {
      const best = first.sort((a, b) => b.confidence - a.confidence)[0]!;
      return { entityKey, factKey, status: 'resolved', value: structuredClone(best.value), confidence: firstScore, claims: structuredClone(claims) };
    }
    return { entityKey, factKey, status: 'conflict', claims: structuredClone(claims) };
  }

  async trace(input: { fromKey: string; toKey?: string; targetType?: string; maxDepth?: number; minConfidence?: number }): Promise<{ entityKeys: string[]; relations: WorldRelation[] } | undefined> {
    await this.#serial;
    const state = await this.#read();
    const now = this.#clock().getTime();
    const fromKey = boundedContext(input.fromKey, 'fromKey');
    const toKey = input.toKey === undefined ? undefined : boundedContext(input.toKey, 'toKey');
    const targetType = input.targetType === undefined ? undefined : boundedKey(input.targetType, 'targetType');
    if (!toKey && !targetType) throw new OperatorError('WORLD_QUERY_INVALID', 'trace requires toKey or targetType.');
    const maxDepth = boundedInteger(input.maxDepth ?? 6, 1, 12, 'maxDepth');
    const minConfidence = boundedConfidence(input.minConfidence ?? 0.5, 'minConfidence');
    if (!state.entities.some((item) => item.key === fromKey)) return undefined;
    const validRelations = state.relations.filter((item) => Date.parse(item.expiresAt) > now && item.confidence >= minConfidence);
    const queue: Array<{ key: string; path: string[]; relations: WorldRelation[] }> = [{ key: fromKey, path: [fromKey], relations: [] }];
    const seen = new Set([fromKey]);
    while (queue.length) {
      const current = queue.shift()!;
      const entity = state.entities.find((item) => item.key === current.key);
      if (current.key !== fromKey && ((toKey && current.key === toKey) || (targetType && entity?.type === targetType))) {
        return { entityKeys: current.path, relations: structuredClone(current.relations) };
      }
      if (current.path.length - 1 >= maxDepth) continue;
      for (const relation of validRelations.filter((item) => item.fromKey === current.key)) {
        if (seen.has(relation.toKey)) continue;
        seen.add(relation.toKey);
        queue.push({ key: relation.toKey, path: [...current.path, relation.toKey], relations: [...current.relations, relation] });
      }
    }
    return undefined;
  }

  async inspectEntity(keyInput: string): Promise<WorldEntity | undefined> {
    await this.#serial;
    const state = await this.#read();
    const key = boundedContext(keyInput, 'entityKey');
    const entity = state.entities.find((item) => item.key === key);
    return entity ? structuredClone(entity) : undefined;
  }

  async listEntities(input: { scopeKey?: string; type?: string; limit?: number } = {}): Promise<WorldEntity[]> {
    await this.#serial;
    const state = await this.#read();
    const scopeKey = input.scopeKey === undefined ? undefined : boundedContext(input.scopeKey, 'scopeKey');
    const type = input.type === undefined ? undefined : boundedKey(input.type, 'type');
    const limit = boundedInteger(input.limit ?? 100, 1, 1000, 'limit');
    return state.entities.filter((item) => (!scopeKey || item.scopeKey === scopeKey) && (!type || item.type === type))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map((item) => structuredClone(item));
  }

  async #read(): Promise<WorldModelState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entities: [], relations: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('WORLD_MODEL_CORRUPT', 'World model could not be read.');
    }
  }

  async #write(state: WorldModelState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function normalizeObservation(input: {
  entity: { key: string; type: string; scopeKey: string; label: string };
  source: string; domain: WorldDomain; evidenceDigest: string; facts?: Record<string, unknown>;
  relations?: Array<{ type: string; toKey: string; confidence?: number }>; confidence?: number; ttlMs?: number;
}) {
  if (!input.entity || typeof input.entity !== 'object') throw new OperatorError('WORLD_INPUT_INVALID', 'entity is required.');
  const facts: Record<string, unknown> = {};
  for (const [keyInput, value] of Object.entries(input.facts ?? {})) {
    const key = boundedKey(keyInput, 'fact key');
    if (SECRET_KEY.test(key)) throw new OperatorError('WORLD_SECRET_FACT_DENIED', 'Secret-bearing fact keys are not accepted by the world model.');
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_FACT_BYTES) throw new OperatorError('WORLD_INPUT_INVALID', `Fact ${key} exceeds bounded JSON size.`);
    facts[key] = JSON.parse(encoded);
  }
  const relations = (input.relations ?? []).map((item, index) => ({
    type: boundedKey(item.type, `relations[${index}].type`),
    toKey: boundedContext(item.toKey, `relations[${index}].toKey`),
    confidence: boundedConfidence(item.confidence ?? input.confidence ?? 0.8, `relations[${index}].confidence`)
  }));
  return {
    entity: {
      key: boundedContext(input.entity.key, 'entity.key'),
      type: boundedKey(input.entity.type, 'entity.type'),
      scopeKey: boundedContext(input.entity.scopeKey, 'entity.scopeKey'),
      label: boundedText(input.entity.label, 4096, 'entity.label')
    },
    source: boundedContext(input.source, 'source'),
    domain: validDomain(input.domain),
    evidenceDigest: shaDigest(input.evidenceDigest, 'evidenceDigest'),
    facts,
    relations,
    confidence: boundedConfidence(input.confidence ?? 0.8, 'confidence'),
    ttlMs: boundedInteger(input.ttlMs ?? 10 * 60_000, MIN_TTL_MS, MAX_TTL_MS, 'ttlMs')
  };
}

function pruneExpired(state: WorldModelState, now: number): void {
  for (const entity of state.entities) {
    for (const fact of entity.facts) fact.claims = fact.claims.filter((claim) => Date.parse(claim.expiresAt) > now);
    entity.facts = entity.facts.filter((fact) => fact.claims.length > 0);
  }
  state.relations = state.relations.filter((relation) => Date.parse(relation.expiresAt) > now);
}

function validateState(input: unknown): WorldModelState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const raw = input as WorldModelState;
  if (raw.version !== 1 || !Array.isArray(raw.entities) || raw.entities.length > MAX_ENTITIES || !Array.isArray(raw.relations) || raw.relations.length > MAX_RELATIONS) throw corrupt('State shape is invalid.');
  const entityKeys = new Set<string>();
  for (const entity of raw.entities) {
    validUuid(entity.id, 'entity id'); boundedContext(entity.key, 'entity key'); boundedKey(entity.type, 'entity type'); boundedContext(entity.scopeKey, 'entity scope'); boundedText(entity.label, 4096, 'entity label');
    if (entityKeys.has(entity.key)) throw corrupt('Entity keys must be unique.');
    entityKeys.add(entity.key);
    if (!Array.isArray(entity.facts) || entity.facts.length > MAX_FACTS_PER_ENTITY) throw corrupt('Entity facts are invalid.');
    for (const fact of entity.facts) {
      boundedKey(fact.key, 'fact key');
      if (SECRET_KEY.test(fact.key) || !Array.isArray(fact.claims) || fact.claims.length > MAX_CLAIMS_PER_FACT) throw corrupt('Stored fact is invalid.');
      for (const claim of fact.claims) {
        validUuid(claim.id, 'claim id'); boundedContext(claim.source, 'claim source'); validDomain(claim.domain); shaDigest(claim.evidenceDigest, 'claim evidence'); shaDigest(claim.valueDigest, 'claim value digest');
        if (digestJson(claim.value) !== claim.valueDigest) throw corrupt('Claim value digest mismatch.');
        boundedConfidence(claim.confidence, 'claim confidence'); validIso(claim.observedAt, 'claim observedAt'); validIso(claim.expiresAt, 'claim expiresAt');
      }
    }
    validIso(entity.createdAt, 'entity createdAt'); validIso(entity.updatedAt, 'entity updatedAt');
  }
  for (const relation of raw.relations) {
    validUuid(relation.id, 'relation id'); boundedContext(relation.fromKey, 'relation fromKey'); boundedContext(relation.toKey, 'relation toKey'); boundedKey(relation.type, 'relation type');
    boundedContext(relation.source, 'relation source'); validDomain(relation.domain); shaDigest(relation.evidenceDigest, 'relation evidence'); boundedConfidence(relation.confidence, 'relation confidence'); validIso(relation.observedAt, 'relation observedAt'); validIso(relation.expiresAt, 'relation expiresAt');
  }
  return structuredClone(raw);
}

function combinedConfidence(claims: WorldClaim[]): number {
  let failure = 1;
  for (const claim of claims) failure *= 1 - claim.confidence;
  return Math.round((1 - failure) * 1000) / 1000;
}
function relationIdentity(item: Pick<WorldRelation, 'fromKey' | 'toKey' | 'type' | 'source' | 'domain'>): string { return [item.fromKey, item.toKey, item.type, item.source, item.domain].join('\0'); }
function digestJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_FACT_BYTES) throw new OperatorError('WORLD_INPUT_INVALID', 'World fact value is not bounded JSON.');
  return crypto.createHash('sha256').update(encoded).digest('hex');
}
function validDomain(input: unknown): WorldDomain {
  const value = String(input ?? '') as WorldDomain;
  if (!['browser', 'application', 'filesystem', 'git', 'database', 'process', 'device', 'project', 'organization', 'other'].includes(value)) throw new OperatorError('WORLD_INPUT_INVALID', 'World domain is invalid.');
  return value;
}
function boundedConfidence(input: unknown, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new OperatorError('WORLD_INPUT_INVALID', `${label} must be from 0 to 1.`);
  return Math.round(value * 1000) / 1000;
}
function boundedContext(input: unknown, label: string): string {
  const value = boundedText(input, 512, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(value)) throw new OperatorError('WORLD_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedKey(input: unknown, label: string): string {
  const value = boundedText(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('WORLD_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function shaDigest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OperatorError('WORLD_INPUT_INVALID', `${label} must be SHA-256.`);
  return value;
}
function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('WORLD_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
function boundedText(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('WORLD_INPUT_INVALID', `${label} is invalid.`);
  return input;
}
function validUuid(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new OperatorError('WORLD_INPUT_INVALID', `${label} must be UUID.`);
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? ''); const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new OperatorError('WORLD_INPUT_INVALID', `${label} must be ISO timestamp.`);
  return value;
}
function corrupt(message: string): OperatorError { return new OperatorError('WORLD_MODEL_CORRUPT', `World model is invalid. ${message}`); }
