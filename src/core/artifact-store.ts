import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import type { ArtifactBlobBackend } from './artifact-object-store.ts';
import {
  createDurableStateBytes,
  readDurableStateBytes,
  readDurableStateText
} from './durable-state.ts';

export type ArtifactKind =
  | 'patch'
  | 'build'
  | 'test-report'
  | 'log'
  | 'screenshot'
  | 'sbom'
  | 'deployment-receipt'
  | 'review-summary'
  | 'evidence-pack'
  | 'generic';

export type ArtifactPrivacy = 'public' | 'internal' | 'sensitive';

export interface ArtifactRecord {
  schemaVersion: 1;
  id: string;
  blobDigest: string;
  bytes: number;
  kind: ArtifactKind;
  mediaType: string;
  privacy: ArtifactPrivacy;
  createdAt: string;
  executionContextDigest?: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface ArtifactPutInput {
  bytes: Uint8Array | string;
  kind?: ArtifactKind;
  mediaType?: string;
  privacy?: ArtifactPrivacy;
  executionContextDigest?: string;
  metadata?: Record<string, string | number | boolean | null>;
  now?: string;
}

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const BLOB_OPTIONS = {
  maxBytes: MAX_ARTIFACT_BYTES,
  errorCode: 'ARTIFACT_BLOB_INVALID',
  invalidMessage: 'Artifact blob is invalid.'
} as const;
const RECORD_OPTIONS = {
  maxBytes: MAX_RECORD_BYTES,
  errorCode: 'ARTIFACT_RECORD_INVALID',
  invalidMessage: 'Artifact record is invalid.'
} as const;
const DIGEST = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+\-]+=[A-Za-z0-9!#$&^_.+\-]+)*$/;

export class ArtifactStore {
  #root: string;
  #blobRoot: string;
  #recordRoot: string;
  #blobBackend?: ArtifactBlobBackend;

  constructor(stateDir: string, options: { blobBackend?: ArtifactBlobBackend } = {}) {
    this.#root = path.join(path.resolve(stateDir), 'artifacts');
    this.#blobRoot = path.join(this.#root, 'blobs', 'sha256');
    this.#recordRoot = path.join(this.#root, 'records');
    this.#blobBackend = options.blobBackend;
  }

  async init(): Promise<void> {
    await this.#ensureDirectory(this.#recordRoot);
    if (!this.#blobBackend) await this.#ensureDirectory(this.#blobRoot);
  }

  async put(input: ArtifactPutInput): Promise<ArtifactRecord> {
    await this.init();
    const bytes = typeof input.bytes === 'string' ? Buffer.from(input.bytes, 'utf8') : Buffer.from(input.bytes);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new OperatorError('ARTIFACT_SIZE_INVALID', `Artifact must contain 1-${MAX_ARTIFACT_BYTES} bytes.`);
    }

    const blobDigest = sha256(bytes);
    const kind = normalizeKind(input.kind ?? 'generic');
    const mediaType = normalizeMediaType(input.mediaType ?? 'application/octet-stream');
    const privacy = normalizePrivacy(input.privacy ?? 'internal');
    const executionContextDigest = normalizeOptionalDigest(input.executionContextDigest, 'executionContextDigest');
    const metadata = normalizeMetadata(input.metadata ?? {});
    const identity = {
      schemaVersion: 1 as const,
      blobDigest,
      bytes: bytes.byteLength,
      kind,
      mediaType,
      privacy,
      ...(executionContextDigest ? { executionContextDigest } : {}),
      metadata
    };
    const id = sha256(Buffer.from(canonicalJson(identity), 'utf8'));
    const createdAt = normalizeIso(input.now ?? new Date().toISOString(), 'createdAt');
    const record: ArtifactRecord = { ...identity, id, createdAt };

    await this.#putBlob(blobDigest, bytes);
    const existing = await this.#putRecord(record);
    return existing ?? record;
  }

  async get(idInput: string): Promise<ArtifactRecord> {
    await this.init();
    const id = normalizeDigest(idInput, 'artifact id');
    let text: string;
    try {
      text = await readDurableStateText(this.#recordPath(id), RECORD_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('ARTIFACT_NOT_FOUND', `Artifact ${id} was not found.`);
      }
      throw error;
    }
    return normalizeRecord(JSON.parse(text), id);
  }

  async read(idInput: string): Promise<{ record: ArtifactRecord; bytes: Buffer }> {
    const record = await this.get(idInput);
    const blob = this.#blobBackend
      ? await this.#blobBackend.get(record.blobDigest)
      : await readDurableStateBytes(this.#blobPath(record.blobDigest), BLOB_OPTIONS);
    if (blob.byteLength !== record.bytes || sha256(blob) !== record.blobDigest) {
      throw new OperatorError('ARTIFACT_INTEGRITY_FAILED', 'Artifact blob digest or size does not match its immutable record.', {
        details: { artifactId: record.id, blobDigest: record.blobDigest }
      });
    }
    return { record, bytes: blob };
  }

  async list(limitInput = 100): Promise<ArtifactRecord[]> {
    await this.init();
    const limit = Math.min(Math.max(Number.isSafeInteger(limitInput) ? limitInput : 100, 1), 1000);
    const names = (await fs.readdir(this.#recordRoot)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort();
    const records: ArtifactRecord[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      records.push(await this.get(id));
    }
    // Artifact ids are content-addresses, not chronological keys. Applying
    // limit before this sort hides newer evidence whose digest sorts later.
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async #putBlob(digest: string, bytes: Buffer): Promise<void> {
    if (this.#blobBackend) {
      await this.#blobBackend.put(digest, bytes);
      return;
    }
    const file = this.#blobPath(digest);
    await this.#ensureDirectory(path.dirname(file));
    try {
      await createDurableStateBytes(file, bytes, BLOB_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readDurableStateBytes(file, BLOB_OPTIONS);
      if (existing.byteLength !== bytes.byteLength || sha256(existing) !== digest) {
        throw new OperatorError('ARTIFACT_INTEGRITY_FAILED', 'Existing artifact blob does not match its content address.', {
          details: { blobDigest: digest }
        });
      }
    }
  }

  async #putRecord(record: ArtifactRecord): Promise<ArtifactRecord | undefined> {
    const file = this.#recordPath(record.id);
    const bytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
    try {
      await createDurableStateBytes(file, bytes, RECORD_OPTIONS);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = normalizeRecord(JSON.parse(await readDurableStateText(file, RECORD_OPTIONS)), record.id);
      const left = canonicalJson({ ...existing, createdAt: undefined });
      const right = canonicalJson({ ...record, createdAt: undefined });
      if (left !== right) {
        throw new OperatorError('ARTIFACT_RECORD_CONFLICT', 'Artifact id already refers to a different immutable record.');
      }
      return existing;
    }
  }

  #blobPath(digest: string): string {
    return path.join(this.#blobRoot, digest.slice(0, 2), digest);
  }

  #recordPath(id: string): string {
    return path.join(this.#recordRoot, `${id}.json`);
  }

  async #ensureDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperatorError('ARTIFACT_STORE_INVALID', 'Artifact store paths must be real directories, not links or special files.');
    }
  }
}

function normalizeRecord(input: unknown, expectedId?: string): ArtifactRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('ARTIFACT_RECORD_INVALID', 'Artifact record must be an object.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new OperatorError('ARTIFACT_RECORD_INVALID', 'Artifact record schema version is invalid.');
  const blobDigest = normalizeDigest(raw.blobDigest, 'blobDigest');
  const bytes = Number(raw.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARTIFACT_BYTES) {
    throw new OperatorError('ARTIFACT_RECORD_INVALID', 'Artifact record byte length is invalid.');
  }
  const kind = normalizeKind(raw.kind);
  const mediaType = normalizeMediaType(raw.mediaType);
  const privacy = normalizePrivacy(raw.privacy);
  const createdAt = normalizeIso(raw.createdAt, 'createdAt');
  const executionContextDigest = normalizeOptionalDigest(raw.executionContextDigest, 'executionContextDigest');
  const metadata = normalizeMetadata(raw.metadata);
  const identity = {
    schemaVersion: 1 as const,
    blobDigest,
    bytes,
    kind,
    mediaType,
    privacy,
    ...(executionContextDigest ? { executionContextDigest } : {}),
    metadata
  };
  const id = normalizeDigest(raw.id, 'artifact id');
  const recomputed = sha256(Buffer.from(canonicalJson(identity), 'utf8'));
  if (id !== recomputed || (expectedId && id !== expectedId)) {
    throw new OperatorError('ARTIFACT_RECORD_INVALID', 'Artifact record content address does not match its identity.');
  }
  return { ...identity, id, createdAt };
}

function normalizeMetadata(input: unknown): Record<string, string | number | boolean | null> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('ARTIFACT_METADATA_INVALID', 'Artifact metadata must be an object.');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 64) throw new OperatorError('ARTIFACT_METADATA_INVALID', 'Artifact metadata may contain at most 64 entries.');
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new OperatorError('ARTIFACT_METADATA_INVALID', `Artifact metadata key ${key} is invalid.`);
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new OperatorError('ARTIFACT_METADATA_INVALID', `Artifact metadata value for ${key} is invalid.`);
    }
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 4096) {
      throw new OperatorError('ARTIFACT_METADATA_INVALID', `Artifact metadata value for ${key} is too large.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new OperatorError('ARTIFACT_METADATA_INVALID', `Artifact metadata value for ${key} is not finite.`);
    }
    output[key] = value as string | number | boolean | null;
  }
  return output;
}

function normalizeKind(value: unknown): ArtifactKind {
  const allowed: ArtifactKind[] = ['patch', 'build', 'test-report', 'log', 'screenshot', 'sbom', 'deployment-receipt', 'review-summary', 'evidence-pack', 'generic'];
  if (typeof value !== 'string' || !allowed.includes(value as ArtifactKind)) {
    throw new OperatorError('ARTIFACT_KIND_INVALID', 'Artifact kind is invalid.');
  }
  return value as ArtifactKind;
}

function normalizePrivacy(value: unknown): ArtifactPrivacy {
  if (!['public', 'internal', 'sensitive'].includes(String(value))) {
    throw new OperatorError('ARTIFACT_PRIVACY_INVALID', 'Artifact privacy class is invalid.');
  }
  return value as ArtifactPrivacy;
}

function normalizeMediaType(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!MEDIA_TYPE.test(text) || text.length > 256) throw new OperatorError('ARTIFACT_MEDIA_TYPE_INVALID', 'Artifact media type is invalid.');
  return text;
}

function normalizeDigest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!DIGEST.test(text)) throw new OperatorError('ARTIFACT_DIGEST_INVALID', `${label} is invalid.`);
  return text;
}

function normalizeOptionalDigest(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeDigest(value, label);
}

function normalizeIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new OperatorError('ARTIFACT_TIMESTAMP_INVALID', `${label} must be a canonical ISO timestamp.`);
  }
  return text;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
