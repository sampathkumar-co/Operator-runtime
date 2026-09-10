import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const PRODUCT = 'operator-runtime';

export type ReleaseChannel = 'stable' | 'beta';
export type ReleaseArtifactKind = 'msix' | 'msixbundle' | 'zip';

export interface ReleaseArtifact {
  platform: 'win32' | 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  kind: ReleaseArtifactKind;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: typeof PRODUCT;
  channel: ReleaseChannel;
  version: string;
  publishedAt: string;
  artifacts: ReleaseArtifact[];
}

export interface SignedReleaseManifest {
  manifest: ReleaseManifest;
  signature: string;
}

export class ReleaseUpdateVerifier {
  #publicKeyPem: string;

  constructor(publicKeyPem: string) {
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new OperatorError('UPDATE_KEY_INVALID', 'Release verification key must be Ed25519.');
    this.#publicKeyPem = key.export({ format: 'pem', type: 'spki' }).toString();
  }

  verifySignedManifest(input: SignedReleaseManifest, options: { channel: ReleaseChannel; currentVersion: string; now?: Date }): ReleaseManifest {
    const manifest = validateManifest(input.manifest);
    if (manifest.channel !== options.channel) throw new OperatorError('UPDATE_CHANNEL_MISMATCH', 'Release manifest channel does not match the configured update channel.');
    if (manifest.channel === 'stable' && manifest.version.includes('-')) throw new OperatorError('UPDATE_CHANNEL_MISMATCH', 'Stable channel manifests cannot publish prerelease versions.');
    const current = validVersion(options.currentVersion);
    if (compareVersions(manifest.version, current) <= 0) throw new OperatorError('UPDATE_NOT_NEWER', 'Release manifest version is not newer than the installed version.');
    const now = options.now ?? new Date();
    const publishedMs = Date.parse(manifest.publishedAt);
    if (publishedMs > now.getTime() + 5 * 60_000) throw new OperatorError('UPDATE_MANIFEST_FUTURE', 'Release manifest publication time is too far in the future.');
    const signature = String(input.signature ?? '');
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(signature)) throw new OperatorError('UPDATE_SIGNATURE_INVALID', 'Release manifest signature is invalid.');
    const bytes = encodeManifest(manifest);
    const ok = crypto.verify(null, bytes, this.#publicKeyPem, Buffer.from(signature, 'base64url'));
    if (!ok) throw new OperatorError('UPDATE_SIGNATURE_INVALID', 'Release manifest signature could not be verified.');
    return manifest;
  }

  selectArtifact(manifestInput: ReleaseManifest, target: { platform: string; arch: string; kinds?: ReleaseArtifactKind[] }): ReleaseArtifact {
    const manifest = validateManifest(manifestInput);
    const kinds = target.kinds ?? ['msixbundle', 'msix', 'zip'];
    for (const kind of kinds) {
      const matches = manifest.artifacts.filter((artifact) => artifact.platform === target.platform && artifact.arch === target.arch && artifact.kind === kind);
      if (matches.length > 1) throw new OperatorError('UPDATE_ARTIFACT_AMBIGUOUS', 'Release manifest contains multiple matching artifacts.');
      if (matches.length === 1) return { ...matches[0] };
    }
    throw new OperatorError('UPDATE_ARTIFACT_NOT_FOUND', 'Release manifest has no artifact for this platform and architecture.');
  }

  async verifyAndStageArtifact(artifactInput: ReleaseArtifact, bytesInput: Uint8Array, stateDir: string, version: string): Promise<{ path: string; sha256: string; sizeBytes: number }> {
    const artifact = validateArtifact(artifactInput);
    const versionText = validVersion(version);
    const bytes = Buffer.from(bytesInput);
    if (bytes.byteLength !== artifact.sizeBytes) throw new OperatorError('UPDATE_SIZE_MISMATCH', 'Downloaded update size does not match the signed release manifest.');
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new OperatorError('UPDATE_ARTIFACT_TOO_LARGE', 'Update artifact exceeds the maximum allowed size.');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== artifact.sha256) throw new OperatorError('UPDATE_HASH_MISMATCH', 'Downloaded update hash does not match the signed release manifest.');

    const root = path.resolve(stateDir);
    const stagingDir = path.join(root, 'updates', versionText);
    await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const extension = artifact.kind === 'msixbundle' ? '.msixbundle' : artifact.kind === 'msix' ? '.msix' : '.zip';
    const finalPath = path.join(stagingDir, `operator-${artifact.platform}-${artifact.arch}${extension}`);

    try {
      const existing = await fs.readFile(finalPath);
      const existingSha = crypto.createHash('sha256').update(existing).digest('hex');
      if (existing.byteLength === bytes.byteLength && existingSha === sha256) return { path: finalPath, sha256, sizeBytes: bytes.byteLength };
      throw new OperatorError('UPDATE_STAGE_CONFLICT', 'A different artifact is already staged for this release target.');
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temp = `${finalPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    try {
      await fs.copyFile(temp, finalPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperatorError('UPDATE_STAGE_CONFLICT', 'An update artifact appeared concurrently at the staging path.');
      throw error;
    } finally {
      await fs.rm(temp, { force: true });
    }
    return { path: finalPath, sha256, sizeBytes: bytes.byteLength };
  }
}

export function signReleaseManifest(manifestInput: ReleaseManifest, privateKeyPem: string): SignedReleaseManifest {
  const manifest = validateManifest(manifestInput);
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new OperatorError('UPDATE_KEY_INVALID', 'Release signing key must be Ed25519.');
  return {
    manifest,
    signature: crypto.sign(null, encodeManifest(manifest), key).toString('base64url')
  };
}

function encodeManifest(manifestInput: ReleaseManifest): Buffer {
  const manifest = validateManifest(manifestInput);
  const canonical = {
    schemaVersion: 1,
    product: PRODUCT,
    channel: manifest.channel,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    artifacts: manifest.artifacts.map((artifact) => ({
      platform: artifact.platform,
      arch: artifact.arch,
      kind: artifact.kind,
      url: artifact.url,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes
    }))
  };
  const bytes = Buffer.from(JSON.stringify(canonical), 'utf8');
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new OperatorError('UPDATE_MANIFEST_TOO_LARGE', 'Release manifest exceeds the maximum allowed size.');
  return bytes;
}

function validateManifest(input: ReleaseManifest): ReleaseManifest {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || input.product !== PRODUCT) throw new OperatorError('UPDATE_MANIFEST_INVALID', 'Release manifest schema or product is invalid.');
  const channel = input.channel === 'stable' ? 'stable' : input.channel === 'beta' ? 'beta' : null;
  if (!channel) throw new OperatorError('UPDATE_MANIFEST_INVALID', 'Release channel is invalid.');
  const version = validVersion(String(input.version ?? ''));
  const publishedAt = validIso(String(input.publishedAt ?? ''));
  if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > MAX_ARTIFACTS) throw new OperatorError('UPDATE_MANIFEST_INVALID', `Release manifest must contain 1-${MAX_ARTIFACTS} artifacts.`);
  const artifacts = input.artifacts.map(validateArtifact);
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const key = `${artifact.platform}:${artifact.arch}:${artifact.kind}`;
    if (seen.has(key)) throw new OperatorError('UPDATE_MANIFEST_INVALID', `Duplicate release artifact ${key}.`);
    seen.add(key);
  }
  artifacts.sort((a, b) => `${a.platform}:${a.arch}:${a.kind}`.localeCompare(`${b.platform}:${b.arch}:${b.kind}`));
  return { schemaVersion: 1, product: PRODUCT, channel, version, publishedAt, artifacts };
}

function validateArtifact(input: ReleaseArtifact): ReleaseArtifact {
  if (!input || typeof input !== 'object') throw new OperatorError('UPDATE_ARTIFACT_INVALID', 'Release artifact is invalid.');
  const platform = input.platform === 'win32' || input.platform === 'linux' || input.platform === 'darwin' ? input.platform : null;
  const arch = input.arch === 'x64' || input.arch === 'arm64' ? input.arch : null;
  const kind = input.kind === 'msix' || input.kind === 'msixbundle' || input.kind === 'zip' ? input.kind : null;
  if (!platform || !arch || !kind) throw new OperatorError('UPDATE_ARTIFACT_INVALID', 'Release artifact platform, architecture, or kind is invalid.');
  let url: URL;
  try { url = new URL(String(input.url)); } catch { throw new OperatorError('UPDATE_URL_INVALID', 'Release artifact URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new OperatorError('UPDATE_URL_INVALID', 'Release artifact URL must use HTTPS and must not contain credentials.');
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new OperatorError('UPDATE_HASH_INVALID', 'Release artifact SHA-256 is invalid.');
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES) throw new OperatorError('UPDATE_SIZE_INVALID', 'Release artifact size is outside the allowed range.');
  return { platform, arch, kind, url: url.toString(), sha256, sizeBytes };
}

function validVersion(value: string): string {
  const text = String(value ?? '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(text) || text.length > 128) {
    throw new OperatorError('UPDATE_VERSION_INVALID', 'Release version must be a bounded semantic version.');
  }
  const prerelease = text.split('-', 2)[1];
  if (prerelease) {
    for (const identifier of prerelease.split('.')) {
      if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
        throw new OperatorError('UPDATE_VERSION_INVALID', 'Numeric prerelease identifiers must not contain leading zeroes.');
      }
    }
  }
  return text;
}

function compareVersions(aInput: string, bInput: string): number {
  const a = parseVersion(validVersion(aInput));
  const b = parseVersion(validVersion(bInput));
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i]! > b.nums[i]! ? 1 : -1;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.pre[i]; const right = b.pre[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

function parseVersion(value: string): { nums: bigint[]; pre: string[] } {
  const [core, prerelease] = value.split('-', 2);
  return { nums: core.split('.').map((part) => BigInt(part)), pre: prerelease ? prerelease.split('.') : [] };
}

function validIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new OperatorError('UPDATE_TIME_INVALID', 'Release publication time must be an ISO timestamp.');
  return value;
}
