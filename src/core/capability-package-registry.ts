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
  type CapabilityExtensionManifest,
  CapabilityExtensionRegistry
} from './capability-sdk.ts';
import type { CapabilityProvider } from './types.ts';
import { OperatorError } from './errors.ts';

export interface CapabilityPublisherIdentity {
  id: string;
  displayName: string;
  publicKeyPem: string;
  enabled: boolean;
}

export interface SignedCapabilityPackage {
  schemaVersion: 1;
  publisherId: string;
  manifest: CapabilityExtensionManifest;
  certification: CapabilityCertification;
  publishedAt: string;
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
    | 'REVOKED';
  entry?: CapabilityRegistryEntry;
}

export function signCapabilityPackage(input: {
  publisherId: string;
  manifest: CapabilityExtensionManifest;
  certification: CapabilityCertification;
  publishedAt?: string;
  privateKeyPem: string;
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
  const payload = unsignedPackage({ publisherId, manifest, certification, publishedAt });
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
    signatureBase64: signature.toString('base64')
  };
}

export function admitCapabilityPackage(input: {
  package: SignedCapabilityPackage;
  publishers: CapabilityPublisherIdentity[];
  revocations?: CapabilityRevocationRecord[];
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
    ...(admission.revocationId ? { revocationId: admission.revocationId } : {})
  };
  return admission.allowed
    ? { allowed: true, reason: 'ADMITTED', entry }
    : { allowed: false, reason: 'REVOKED', entry };
}


export function registerAdmittedCapabilityPackage(input:{
  package:SignedCapabilityPackage;
  publishers:CapabilityPublisherIdentity[];
  revocations?:CapabilityRevocationRecord[];
  provider:CapabilityProvider;
  registry:CapabilityExtensionRegistry;
}):{admission:CapabilityRegistryAdmission;provider:CapabilityProvider}{
  const admission=admitCapabilityPackage({
    package:input.package,
    publishers:input.publishers,
    revocations:input.revocations
  });
  if(!admission.allowed){
    throw new OperatorError('CAPABILITY_PACKAGE_ADMISSION_DENIED', 'Capability package cannot enter production runtime.', {
      details:{reason:admission.reason}
    });
  }
  const provider=input.registry.register(input.package.manifest,input.provider,{trust:'certified'});
  return {admission,provider};
}

function normalizePackage(input: SignedCapabilityPackage): SignedCapabilityPackage {
  if (!input || input.schemaVersion !== 1) throw invalid('Signed capability package shape is invalid.');
  const publisherId = id(input.publisherId, 'publisherId');
  const manifest = validateManifest(input.manifest);
  const certification = validateCapabilityCertification(input.certification);
  const publishedAt = iso(input.publishedAt, 'publishedAt');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(input.signatureBase64 ?? '')) ||
      Buffer.from(input.signatureBase64, 'base64').length !== 64) throw invalid('Capability package signature is invalid.');
  return {
    schemaVersion: 1,
    publisherId,
    manifest,
    certification,
    publishedAt,
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
}) {
  return {
    schemaVersion: 1,
    publisherId: input.publisherId,
    manifest: input.manifest,
    certification: input.certification,
    publishedAt: input.publishedAt
  };
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
