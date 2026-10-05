import crypto from 'node:crypto';

export const ADAPTIVE_STATE_SCHEMA = 'mecord.adaptive-intelligence';
export const ADAPTIVE_STATE_VERSION = 1;

export interface VersionedStateEnvelope<T> {
  schema: typeof ADAPTIVE_STATE_SCHEMA;
  version: number;
  kind: string;
  createdAt: string;
  payload: T;
  payloadDigest: string;
}

export interface DecodeStateOptions<T> {
  kind: string;
  validate: (payload: unknown) => T;
  acceptedVersions?: number[];
}

export function encodeVersionedState<T>(
  kindInput: string,
  payload: T,
  options: { clock?: () => Date } = {}
): VersionedStateEnvelope<T> {
  const kind = bounded(kindInput, 256, 'kind');
  const canonical = canonicalJson(payload);
  return {
    schema: ADAPTIVE_STATE_SCHEMA,
    version: ADAPTIVE_STATE_VERSION,
    kind,
    createdAt: (options.clock ?? (() => new Date()))().toISOString(),
    payload: structuredClone(payload),
    payloadDigest: crypto.createHash('sha256').update(canonical).digest('hex')
  };
}

export function decodeVersionedState<T>(
  input: unknown,
  options: DecodeStateOptions<T>
): VersionedStateEnvelope<T> {
  if (!input || typeof input !== 'object') throw new Error('Versioned state envelope is required.');
  const raw = input as Record<string, unknown>;
  if (raw.schema !== ADAPTIVE_STATE_SCHEMA) throw new Error('Unsupported adaptive state schema.');
  const version = Number(raw.version);
  if (!Number.isSafeInteger(version)) throw new Error('Adaptive state version is invalid.');
  const accepted = options.acceptedVersions ?? [ADAPTIVE_STATE_VERSION];
  if (!accepted.includes(version)) throw new Error('Unsupported adaptive state version: ' + version + '.');
  const kind = bounded(raw.kind, 256, 'kind');
  if (kind !== options.kind) throw new Error('Adaptive state kind mismatch.');
  const createdAt = validIso(raw.createdAt, 'createdAt');
  const payload = options.validate(raw.payload);
  const digest = sha256(raw.payloadDigest, 'payloadDigest');
  const actual = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
  if (!timingSafeHexEqual(actual, digest)) throw new Error('Adaptive state payload digest mismatch.');
  return {
    schema: ADAPTIVE_STATE_SCHEMA,
    version,
    kind,
    createdAt,
    payload,
    payloadDigest: digest
  };
}

export function canonicalJson(input: unknown): string {
  return JSON.stringify(sortValue(input, new WeakSet<object>()));
}

function sortValue(input: unknown, active: WeakSet<object>): unknown {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Non-finite numbers cannot be serialized.');
    // JSON stringifies -0 as 0; normalize explicitly so digest semantics are clear.
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input === 'bigint' || typeof input === 'function' || typeof input === 'symbol' || input === undefined) {
    throw new Error('Unsupported value in adaptive state serialization.');
  }

  if (Array.isArray(input)) {
    if (active.has(input)) throw new Error('Cyclic adaptive state cannot be serialized.');
    active.add(input);
    try {
      return input.map((item) => sortValue(item, active));
    } finally {
      active.delete(input);
    }
  }

  if (typeof input === 'object') {
    const object = input as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Only plain JSON objects are supported in adaptive state serialization.');
    }
    if (active.has(object)) throw new Error('Cyclic adaptive state cannot be serialized.');
    active.add(object);
    try {
      return Object.fromEntries(
        Object.keys(object).sort().map((key) => [key, sortValue(object[key], active)])
      );
    } finally {
      active.delete(object);
    }
  }

  throw new Error('Unsupported value in adaptive state serialization.');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function bounded(input: unknown, max: number, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > max) throw new Error(label + ' is invalid.');
  return value;
}
function sha256(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(label + ' must be SHA-256.');
  return value;
}
function validIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(label + ' must be ISO timestamp.');
  return value;
}
