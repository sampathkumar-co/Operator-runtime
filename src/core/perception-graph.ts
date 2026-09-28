import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

export type PerceptionChannel = 'dom' | 'accessibility' | 'uia' | 'visual' | 'application' | 'runtime';

export interface PerceptionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PerceptionObservation {
  sceneKey: string;
  channel: PerceptionChannel;
  source: string;
  semanticId?: string;
  role?: string;
  name?: string;
  text?: string;
  bounds?: PerceptionBounds;
  state?: Record<string, string | number | boolean | null>;
  confidence: number;
  ttlMs?: number;
  evidenceDigest: string;
}

export interface PerceptionClaim {
  id: string;
  channel: PerceptionChannel;
  source: string;
  role?: string;
  name?: string;
  text?: string;
  bounds?: PerceptionBounds;
  state: Record<string, string | number | boolean | null>;
  confidence: number;
  evidenceDigest: string;
  observedAt: string;
  expiresAt: string;
}

export interface PerceptionNode {
  id: string;
  sceneKey: string;
  semanticId?: string;
  claims: PerceptionClaim[];
  createdAt: string;
  updatedAt: string;
}

interface PerceptionState {
  version: 1;
  nodes: PerceptionNode[];
}

export interface GroundedTarget {
  node: PerceptionNode;
  confidence: number;
  role?: string;
  name?: string;
  text?: string;
  bounds?: PerceptionBounds;
  state: Record<string, string | number | boolean | null>;
  channels: PerceptionChannel[];
}

const MAX_NODES = 20_000;
const MAX_CLAIMS = 12;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_TTL = 24 * 60 * 60_000;
const MIN_TTL = 1_000;
const SECRET_KEY = /(pass(word)?|secret|token|authorization|cookie|credential|private.?key|api.?key)/i;
const STORE_OPTIONS = {
  maxBytes: MAX_STATE_BYTES,
  errorCode: 'PERCEPTION_STATE_CORRUPT',
  invalidMessage: 'Perception graph is invalid.'
} as const;

export class PerceptionGraphStore {
  #file: string;
  #clock: () => Date;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'perception-graph.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async observe(input: PerceptionObservation): Promise<PerceptionNode> {
    const normalized = normalizeObservation(input);
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      prune(state, now.getTime());
      let node = resolveNode(state, normalized);
      if (!node) {
        if (state.nodes.length >= MAX_NODES) throw new OperatorError('PERCEPTION_LIMIT', 'Perception node limit reached.');
        node = {
          id: crypto.randomUUID(),
          sceneKey: normalized.sceneKey,
          ...(normalized.semanticId ? { semanticId: normalized.semanticId } : {}),
          claims: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        };
        state.nodes.push(node);
      } else if (normalized.semanticId && !node.semanticId) {
        node.semanticId = normalized.semanticId;
      }

      const claim: PerceptionClaim = {
        id: crypto.randomUUID(),
        channel: normalized.channel,
        source: normalized.source,
        ...(normalized.role ? { role: normalized.role } : {}),
        ...(normalized.name ? { name: normalized.name } : {}),
        ...(normalized.text ? { text: normalized.text } : {}),
        ...(normalized.bounds ? { bounds: normalized.bounds } : {}),
        state: normalized.state,
        confidence: normalized.confidence,
        evidenceDigest: normalized.evidenceDigest,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + normalized.ttlMs).toISOString()
      };
      node.claims.push(claim);
      node.claims.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      if (node.claims.length > MAX_CLAIMS) node.claims.length = MAX_CLAIMS;
      node.updatedAt = now.toISOString();
      state.nodes.sort((a, b) => a.sceneKey.localeCompare(b.sceneKey) || a.id.localeCompare(b.id));
      await this.#write(state);
      return structuredClone(node);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    return await run;
  }

  async ground(input: {
    sceneKey: string;
    semanticId?: string;
    role?: string;
    name?: string;
    text?: string;
    near?: PerceptionBounds;
    minConfidence?: number;
  }): Promise<GroundedTarget> {
    await this.#serial;
    const state = await this.#read();
    const now = this.#clock().getTime();
    prune(state, now);
    const sceneKey = bounded(input.sceneKey, 1024, 'sceneKey');
    const minConfidence = confidence(input.minConfidence ?? 0.5);
    const candidates = state.nodes
      .filter((node) => node.sceneKey === sceneKey)
      .map((node) => fuse(node, now))
      .filter((item): item is GroundedTarget => Boolean(item))
      .filter((item) => item.confidence >= minConfidence)
      .filter((item) => !input.semanticId || item.node.semanticId === input.semanticId)
      .filter((item) => !input.role || sameText(item.role, input.role))
      .filter((item) => !input.name || sameText(item.name, input.name))
      .filter((item) => !input.text || sameText(item.text, input.text))
      .map((item) => ({ item, score: groundingScore(item, input.near) }))
      .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence || a.item.node.id.localeCompare(b.item.node.id));

    if (candidates.length === 0) throw new OperatorError('PERCEPTION_TARGET_NOT_FOUND', 'No grounded target satisfies the selector.');
    if (candidates.length > 1 && Math.abs(candidates[0]!.score - candidates[1]!.score) < 0.05) {
      throw new OperatorError('PERCEPTION_TARGET_AMBIGUOUS', 'Multiple grounded targets match with similar confidence.', {
        details: { candidates: candidates.slice(0, 5).map(({ item, score }) => ({ id: item.node.id, score, confidence: item.confidence })) }
      });
    }
    return structuredClone(candidates[0]!.item);
  }

  async scene(sceneKeyInput: string): Promise<GroundedTarget[]> {
    await this.#serial;
    const state = await this.#read();
    const now = this.#clock().getTime();
    const sceneKey = bounded(sceneKeyInput, 1024, 'sceneKey');
    return state.nodes
      .filter((node) => node.sceneKey === sceneKey)
      .map((node) => fuse(node, now))
      .filter((item): item is GroundedTarget => Boolean(item))
      .sort((a, b) => b.confidence - a.confidence || a.node.id.localeCompare(b.node.id))
      .map((item) => structuredClone(item));
  }

  async #read(): Promise<PerceptionState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nodes: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception graph could not be read.');
    }
  }

  async #write(state: PerceptionState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS);
  }
}

function normalizeObservation(input: PerceptionObservation) {
  if (!input || typeof input !== 'object') throw new OperatorError('PERCEPTION_INPUT_INVALID', 'Perception observation is required.');
  const state = input.state ?? {};
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new OperatorError('PERCEPTION_INPUT_INVALID', 'Perception state must be an object.');
  for (const [key, value] of Object.entries(state)) {
    if (SECRET_KEY.test(key)) throw new OperatorError('PERCEPTION_SECRET_REJECTED', 'Secret-bearing perception state is rejected.');
    if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      throw new OperatorError('PERCEPTION_INPUT_INVALID', 'Perception state values must be scalar.');
    }
  }
  if (!/^[0-9a-f]{64}$/i.test(input.evidenceDigest)) throw new OperatorError('PERCEPTION_INPUT_INVALID', 'evidenceDigest must be SHA-256.');
  if (!['dom', 'accessibility', 'uia', 'visual', 'application', 'runtime'].includes(input.channel)) {
    throw new OperatorError('PERCEPTION_INPUT_INVALID', 'Perception channel is invalid.');
  }
  const ttlMs = integer(input.ttlMs ?? 30_000, MIN_TTL, MAX_TTL, 'ttlMs');
  return {
    sceneKey: bounded(input.sceneKey, 1024, 'sceneKey'),
    channel: input.channel,
    source: bounded(input.source, 512, 'source'),
    semanticId: optional(input.semanticId, 512, 'semanticId'),
    role: optional(input.role, 256, 'role'),
    name: optional(input.name, 1024, 'name'),
    text: optional(input.text, 4096, 'text'),
    bounds: input.bounds ? normalizedBounds(input.bounds) : undefined,
    state: structuredClone(state),
    confidence: confidence(input.confidence),
    ttlMs,
    evidenceDigest: input.evidenceDigest.toLowerCase()
  };
}

function resolveNode(state: PerceptionState, observation: ReturnType<typeof normalizeObservation>): PerceptionNode | undefined {
  if (observation.semanticId) {
    const semantic = state.nodes.find((node) => node.sceneKey === observation.sceneKey && node.semanticId === observation.semanticId);
    if (semantic) return semantic;
  }
  const candidates = state.nodes.filter((node) => node.sceneKey === observation.sceneKey).map((node) => {
    const recent = node.claims[0];
    const overlap = recent?.bounds && observation.bounds
      ? intersectionOverUnion(recent.bounds, observation.bounds)
      : undefined;
    // Repeated labels are common ("OK", "Save", icon-only buttons). Without a
    // stable semantic id, spatially disjoint observations must remain distinct
    // objects instead of being fused from text similarity alone.
    if (overlap !== undefined && overlap < 0.1) return { node, score: 0 };
    let score = 0;
    if (recent?.role && observation.role && sameText(recent.role, observation.role)) score += 0.25;
    if (recent?.name && observation.name && sameText(recent.name, observation.name)) score += 0.35;
    if (recent?.text && observation.text && sameText(recent.text, observation.text)) score += 0.2;
    if (overlap !== undefined) score += 0.4 * overlap;
    return { node, score };
  }).filter((item) => item.score >= 0.55).sort((a, b) => b.score - a.score);
  if (candidates.length === 1 || (candidates[0] && candidates[1] && candidates[0].score - candidates[1].score >= 0.15)) return candidates[0]?.node;
  return undefined;
}

function fuse(node: PerceptionNode, now: number): GroundedTarget | undefined {
  const claims = node.claims.filter((claim) => Date.parse(claim.expiresAt) > now);
  if (claims.length === 0) return undefined;
  const ranked = claims.slice().sort((a, b) => channelWeight(b.channel) * b.confidence - channelWeight(a.channel) * a.confidence || b.observedAt.localeCompare(a.observedAt));
  const best = ranked[0]!;
  const confidenceValue = 1 - ranked.reduce((remaining, claim) => remaining * (1 - Math.min(0.99, claim.confidence * channelWeight(claim.channel))), 1);
  return {
    node: structuredClone(node),
    confidence: Math.min(1, confidenceValue),
    ...(best.role ? { role: best.role } : {}),
    ...(best.name ? { name: best.name } : {}),
    ...(best.text ? { text: best.text } : {}),
    ...(best.bounds ? { bounds: structuredClone(best.bounds) } : {}),
    state: structuredClone(best.state),
    channels: [...new Set(ranked.map((claim) => claim.channel))].sort()
  };
}

function channelWeight(channel: PerceptionChannel): number {
  if (channel === 'dom' || channel === 'uia' || channel === 'accessibility') return 1;
  if (channel === 'application' || channel === 'runtime') return 0.95;
  return 0.8;
}

function groundingScore(item: GroundedTarget, near?: PerceptionBounds): number {
  let score = item.confidence;
  if (near && item.bounds) score += 0.25 * intersectionOverUnion(item.bounds, near);
  if (item.node.semanticId) score += 0.1;
  return score;
}

function intersectionOverUnion(a: PerceptionBounds, b: PerceptionBounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function normalizedBounds(input: PerceptionBounds): PerceptionBounds {
  const values = [input.x, input.y, input.width, input.height];
  if (values.some((value) => !Number.isFinite(value)) || input.width <= 0 || input.height <= 0 || input.width > 100_000 || input.height > 100_000) {
    throw new OperatorError('PERCEPTION_INPUT_INVALID', 'Perception bounds are invalid.');
  }
  return { x: input.x, y: input.y, width: input.width, height: input.height };
}

function prune(state: PerceptionState, now: number): void {
  for (const node of state.nodes) node.claims = node.claims.filter((claim) => Date.parse(claim.expiresAt) > now);
  state.nodes = state.nodes.filter((node) => node.claims.length > 0);
}

function validateState(input: unknown): PerceptionState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception state must be an object.');
  const state = input as PerceptionState;
  if (state.version !== 1 || !Array.isArray(state.nodes) || state.nodes.length > MAX_NODES) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception state shape is invalid.');
  for (const node of state.nodes) {
    if (!/^[0-9a-f-]{36}$/i.test(node.id)) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception node id is invalid.');
    bounded(node.sceneKey, 1024, 'sceneKey');
    if (node.semanticId) bounded(node.semanticId, 512, 'semanticId');
    if (!Array.isArray(node.claims) || node.claims.length > MAX_CLAIMS) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception claims are invalid.');
    for (const claim of node.claims) {
      if (!/^[0-9a-f-]{36}$/i.test(claim.id) || !/^[0-9a-f]{64}$/i.test(claim.evidenceDigest)) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception claim identity is invalid.');
      confidence(claim.confidence);
      if (!Number.isFinite(Date.parse(claim.observedAt)) || !Number.isFinite(Date.parse(claim.expiresAt))) throw new OperatorError('PERCEPTION_STATE_CORRUPT', 'Perception claim timestamp is invalid.');
    }
  }
  return state;
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return normalizeText(a) === normalizeText(b);
}

function normalizeText(value: string | undefined): string {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) throw new OperatorError('PERCEPTION_INPUT_INVALID', `${label} is invalid.`);
  return input;
}

function optional(input: unknown, max: number, label: string): string | undefined {
  return input === undefined ? undefined : bounded(input, max, label);
}

function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('PERCEPTION_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function confidence(input: unknown): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new OperatorError('PERCEPTION_INPUT_INVALID', 'confidence must be between 0 and 1.');
  return value;
}

export function perceptionDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
