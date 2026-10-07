import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import {
  evaluateCapabilityAdmission,
  validateCapabilityCertification,
  validateCapabilityRevocation,
  type CapabilityCertification,
  type CapabilityRevocationRecord
} from './capability-conformance.ts';
import {
  capabilityManifestDigest,
  validateManifest,
  type CapabilityExtensionManifest
} from './capability-sdk.ts';
import { OperatorError } from './errors.ts';

export interface CapabilityPublisherIdentity {
  id: string;
  displayName: string;
  publicKeyPem: string;
  enabled: boolean;
}

export interface CapabilityBuildMetadata {
  sourceDigest: string;
  buildRecipeDigest: string;
  builderId: string;
  builtAt: string;
  reproducible: boolean;
}

export interface CapabilityLifecyclePolicy {
  deprecatedAt?: string;
  sunsetAt?: string;
  vulnerabilityChannel: string;
}

export interface SignedCapabilityPackage {
  schemaVersion: 1;
  publisherId: string;
  manifest: CapabilityExtensionManifest;
  certification: CapabilityCertification;
  publishedAt: string;
  build?: CapabilityBuildMetadata;
  lifecycle?: CapabilityLifecyclePolicy;
  signatureBase64: string;
}

export interface CapabilityRegistryEntry {
  schemaVersion: 1;
  packageId: string;
  publisherId: string;
  manifestDigest: string;
  extensionId: string;
  extensionVersion: string;
  certificationId: string;
  publishedAt: string;
  status: 'ADMITTED' | 'REVOKED';
  buildDigest?: string;
  deprecated?: boolean;
  sunsetAt?: string;
  revocationId?: string;
}

export interface CapabilityRegistryAdmission {
  allowed: boolean;
  reason:
    | 'ADMITTED'
    | 'PUBLISHER_UNKNOWN'
    | 'PUBLISHER_DISABLED'
    | 'SIGNATURE_INVALID'
    | 'CERTIFICATION_INVALID'
    | 'BUILD_METADATA_MISSING'
    | 'BUILD_NOT_REPRODUCIBLE'
    | 'LIFECYCLE_POLICY_MISSING'
    | 'PACKAGE_SUNSET'
    | 'REVOKED';
  entry?: CapabilityRegistryEntry;
}

export function signCapabilityPackage(input: {
  publisherId: string;
  manifest: CapabilityExtensionManifest;
  certification: CapabilityCertification;
  publishedAt?: string;
  privateKeyPem: string;
  build?: CapabilityBuildMetadata;
  lifecycle?: CapabilityLifecyclePolicy;
}): SignedCapabilityPackage {
  const publisherId = id(input.publisherId, 'publisherId');
  const manifest = validateManifest(input.manifest);
  const certification = validateCapabilityCertification(input.certification);
  const manifestDigest = capabilityManifestDigest(manifest);
  if (certification.manifestDigest !== manifestDigest ||
      certification.extensionId !== manifest.id ||
      certification.extensionVersion !== manifest.version ||
      certification.status !== 'CERTIFIED') {
    throw invalid('Capability package certification does not certify the exact manifest.');
  }
  const publishedAt = iso(input.publishedAt ?? new Date().toISOString(), 'publishedAt');
  const build = input.build === undefined ? undefined : normalizeBuild(input.build);
  const lifecycle = input.lifecycle === undefined ? undefined : normalizeLifecycle(input.lifecycle, publishedAt);
  const payload = unsignedPackage({ publisherId, manifest, certification, publishedAt, ...(build ? { build } : {}), ...(lifecycle ? { lifecycle } : {}) });
  let signature: Buffer;
  try {
    const key = crypto.createPrivateKey(input.privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    signature = crypto.sign(null, Buffer.from(canonicalJson(payload), 'utf8'), key);
  } catch {
    throw invalid('Capability publisher signing key is invalid.');
  }
  return {
    schemaVersion: 1,
    publisherId,
    manifest,
    certification,
    publishedAt,
    ...(build ? { build } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    signatureBase64: signature.toString('base64')
  };
}

export function admitCapabilityPackage(input: {
  package: SignedCapabilityPackage;
  publishers: CapabilityPublisherIdentity[];
  revocations?: CapabilityRevocationRecord[];
  requireGovernanceMetadata?: boolean;
  now?: string;
}): CapabilityRegistryAdmission {
  let pkg: SignedCapabilityPackage;
  try {
    pkg = normalizePackage(input.package);
  } catch {
    return { allowed: false, reason: 'CERTIFICATION_INVALID' };
  }
  if (!Array.isArray(input.publishers) || input.publishers.length > 100_000) throw invalid('Publisher registry is invalid.');
  const publishers = new Map<string, CapabilityPublisherIdentity>();
  for (const raw of input.publishers) {
    const publisher = normalizePublisher(raw);
    if (publishers.has(publisher.id)) throw invalid('Publisher registry contains duplicate ids.');
    publishers.set(publisher.id, publisher);
  }
  const publisher = publishers.get(pkg.publisherId);
  if (!publisher) return { allowed: false, reason: 'PUBLISHER_UNKNOWN' };
  if (!publisher.enabled) return { allowed: false, reason: 'PUBLISHER_DISABLED' };

  let signatureValid = false;
  try {
    const key = crypto.createPublicKey(publisher.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return { allowed: false, reason: 'SIGNATURE_INVALID' };
    signatureValid = crypto.verify(
      null,
      Buffer.from(canonicalJson(unsignedPackage(pkg)), 'utf8'),
      key,
      Buffer.from(pkg.signatureBase64, 'base64')
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { allowed: false, reason: 'SIGNATURE_INVALID' };

  if (input.requireGovernanceMetadata) {
    if (!pkg.build) return { allowed: false, reason: 'BUILD_METADATA_MISSING' };
    if (!pkg.build.reproducible) return { allowed: false, reason: 'BUILD_NOT_REPRODUCIBLE' };
    if (!pkg.lifecycle) return { allowed: false, reason: 'LIFECYCLE_POLICY_MISSING' };
    const now = iso(input.now ?? new Date().toISOString(), 'now');
    if (pkg.lifecycle.sunsetAt && Date.parse(pkg.lifecycle.sunsetAt) <= Date.parse(now)) {
      return { allowed: false, reason: 'PACKAGE_SUNSET' };
    }
  }

  const manifestDigest = capabilityManifestDigest(pkg.manifest);
  if (
    pkg.certification.status !== 'CERTIFIED' ||
    pkg.certification.manifestDigest !== manifestDigest ||
    pkg.certification.extensionId !== pkg.manifest.id ||
    pkg.certification.extensionVersion !== pkg.manifest.version
  ) return { allowed: false, reason: 'CERTIFICATION_INVALID' };

  const revocations = (input.revocations ?? []).map(validateCapabilityRevocation);
  const admission = evaluateCapabilityAdmission(pkg.certification, revocations);
  const packageId = sha256(canonicalJson({
    publisherId: pkg.publisherId,
    manifestDigest,
    certificationId: pkg.certification.id,
    publishedAt: pkg.publishedAt,
    signatureBase64: pkg.signatureBase64
  }));
  const entry: CapabilityRegistryEntry = {
    schemaVersion: 1,
    packageId,
    publisherId: pkg.publisherId,
    manifestDigest,
    extensionId: pkg.manifest.id,
    extensionVersion: pkg.manifest.version,
    certificationId: pkg.certification.id,
    publishedAt: pkg.publishedAt,
    status: admission.allowed ? 'ADMITTED' : 'REVOKED',
    ...(pkg.build ? { buildDigest: sha256(canonicalJson(pkg.build)) } : {}),
    ...(pkg.lifecycle?.deprecatedAt ? { deprecated: Date.parse(pkg.lifecycle.deprecatedAt) <= Date.parse(pkg.publishedAt) } : {}),
    ...(pkg.lifecycle?.sunsetAt ? { sunsetAt: pkg.lifecycle.sunsetAt } : {}),
    ...(admission.revocationId ? { revocationId: admission.revocationId } : {})
  };
  return admission.allowed
    ? { allowed: true, reason: 'ADMITTED', entry }
    : { allowed: false, reason: 'REVOKED', entry };
}

function normalizePackage(input: SignedCapabilityPackage): SignedCapabilityPackage {
  if (!input || input.schemaVersion !== 1) throw invalid('Signed capability package shape is invalid.');
  const publisherId = id(input.publisherId, 'publisherId');
  const manifest = validateManifest(input.manifest);
  const certification = validateCapabilityCertification(input.certification);
  const publishedAt = iso(input.publishedAt, 'publishedAt');
  const build = input.build === undefined ? undefined : normalizeBuild(input.build);
  const lifecycle = input.lifecycle === undefined ? undefined : normalizeLifecycle(input.lifecycle, publishedAt);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(input.signatureBase64 ?? '')) ||
      Buffer.from(input.signatureBase64, 'base64').length !== 64) throw invalid('Capability package signature is invalid.');
  return {
    schemaVersion: 1,
    publisherId,
    manifest,
    certification,
    publishedAt,
    ...(build ? { build } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    signatureBase64: input.signatureBase64
  };
}

function normalizePublisher(input: CapabilityPublisherIdentity): CapabilityPublisherIdentity {
  if (!input || typeof input !== 'object') throw invalid('Publisher identity is invalid.');
  const idValue = id(input.id, 'publisher.id');
  const displayName = text(input.displayName, 256, 'publisher.displayName');
  if (typeof input.enabled !== 'boolean') throw invalid('Publisher enabled flag is invalid.');
  let publicKeyPem: string;
  try {
    const key = crypto.createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    publicKeyPem = key.export({ format: 'pem', type: 'spki' }).toString();
  } catch {
    throw invalid('Publisher public key is invalid.');
  }
  return { id: idValue, displayName, publicKeyPem, enabled: input.enabled };
}

function unsignedPackage(input: {
  publisherId: string;
  manifest: CapabilityExtensionManifest;
  certification: CapabilityCertification;
  publishedAt: string;
  build?: CapabilityBuildMetadata;
  lifecycle?: CapabilityLifecyclePolicy;
}) {
  return {
    schemaVersion: 1,
    publisherId: input.publisherId,
    manifest: input.manifest,
    certification: input.certification,
    publishedAt: input.publishedAt,
    ...(input.build ? { build: input.build } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {})
  };
}

function normalizeBuild(input: CapabilityBuildMetadata): CapabilityBuildMetadata {
  if (!input || typeof input !== 'object') throw invalid('Capability build metadata is invalid.');
  if (typeof input.reproducible !== 'boolean') throw invalid('Capability reproducible-build flag is invalid.');
  return {
    sourceDigest: digest(input.sourceDigest, 'build.sourceDigest'),
    buildRecipeDigest: digest(input.buildRecipeDigest, 'build.buildRecipeDigest'),
    builderId: id(input.builderId, 'build.builderId'),
    builtAt: iso(input.builtAt, 'build.builtAt'),
    reproducible: input.reproducible
  };
}

function normalizeLifecycle(input: CapabilityLifecyclePolicy, publishedAt: string): CapabilityLifecyclePolicy {
  if (!input || typeof input !== 'object') throw invalid('Capability lifecycle policy is invalid.');
  const deprecatedAt = input.deprecatedAt === undefined ? undefined : iso(input.deprecatedAt, 'lifecycle.deprecatedAt');
  const sunsetAt = input.sunsetAt === undefined ? undefined : iso(input.sunsetAt, 'lifecycle.sunsetAt');
  if (deprecatedAt && sunsetAt && Date.parse(sunsetAt) < Date.parse(deprecatedAt)) throw invalid('Capability sunset cannot precede deprecation.');
  if (sunsetAt && Date.parse(sunsetAt) < Date.parse(publishedAt)) throw invalid('Capability sunset cannot precede publication.');
  const channel = String(input.vulnerabilityChannel ?? '');
  let parsed: URL;
  try { parsed = new URL(channel); } catch { throw invalid('Capability vulnerability channel must be a URL.'); }
  if (!['https:','mailto:'].includes(parsed.protocol)) throw invalid('Capability vulnerability channel must use HTTPS or mailto.');
  return { ...(deprecatedAt ? { deprecatedAt } : {}), ...(sunsetAt ? { sunsetAt } : {}), vulnerabilityChannel: parsed.toString() };
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(label + ' must be SHA-256.');
  return value;
}

function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+-=]{1,256}$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}
function text(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > max) throw invalid(label + ' is invalid.');
  return input.trim();
}
function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalid(message: string): OperatorError {
  return new OperatorError('CAPABILITY_PACKAGE_REGISTRY_INVALID', message);
}
