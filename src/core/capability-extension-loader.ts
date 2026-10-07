import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CapabilityProvider } from './types.ts';
import type { SignedCapabilityPackage } from './capability-package-registry.ts';
import { CapabilityGovernanceRegistry } from './capability-governance.ts';
import { OperatorError } from './errors.ts';

export interface CapabilityModuleFactory {
  createCapabilityProvider?: (input: { manifest: SignedCapabilityPackage['manifest'] }) => CapabilityProvider | Promise<CapabilityProvider>;
  default?: unknown;
}

export async function loadGovernedCapabilityModule(input: {
  modulePath: string;
  allowedRoots: string[];
  package: SignedCapabilityPackage;
  governance: CapabilityGovernanceRegistry;
}): Promise<CapabilityProvider> {
  const admission = input.governance.currentAdmission(input.package);
  if (!admission.allowed) throw new OperatorError('CAPABILITY_PACKAGE_NOT_ADMITTED', `Capability package admission failed before load: ${admission.reason}.`);
  const modulePath = await resolveAllowedExisting(input.modulePath, input.allowedRoots);
  const bytes = await fs.readFile(modulePath);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== input.package.manifest.provenance.packageDigest) {
    throw new OperatorError('CAPABILITY_MODULE_DIGEST_MISMATCH', 'Capability module bytes do not match the signed manifest package digest.');
  }
  const namespace = await import(pathToFileURL(modulePath).href + `?sha256=${digest}`) as CapabilityModuleFactory;
  const factory = typeof namespace.createCapabilityProvider === 'function'
    ? namespace.createCapabilityProvider
    : typeof namespace.default === 'function'
      ? namespace.default as CapabilityModuleFactory['createCapabilityProvider']
      : undefined;
  if (!factory) throw new OperatorError('CAPABILITY_MODULE_FACTORY_MISSING', 'Capability module must export createCapabilityProvider(manifest) or a default factory.');
  const provider = await factory({ manifest: structuredClone(input.package.manifest) });
  if (!provider || typeof provider.name !== 'string' || typeof provider.execute !== 'function') {
    throw new OperatorError('CAPABILITY_MODULE_PROVIDER_INVALID', 'Capability module factory returned an invalid provider.');
  }
  return input.governance.wrap(input.package, provider);
}

async function resolveAllowedExisting(inputPath:string, roots:string[]):Promise<string> {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 128) throw new OperatorError('CAPABILITY_MODULE_ROOTS_INVALID','At least one authorized module root is required.');
  const real = await fs.realpath(path.resolve(inputPath));
  const resolvedRoots = await Promise.all(roots.map(async root => {
    try { return await fs.realpath(path.resolve(root)); } catch { return path.resolve(root); }
  }));
  const allowed = resolvedRoots.some(root => {
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!allowed) throw new OperatorError('CAPABILITY_MODULE_OUTSIDE_SCOPE','Capability module path escapes authorized module roots.');
  return real;
}
