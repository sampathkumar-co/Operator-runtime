import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { PermissionProfile } from '../../../src/core/types.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { PathScope } from '../../../src/capabilities/path-scope.ts';
import { semanticCheckpointDigest, type SemanticCheckpointArtifact, type SemanticWorldAssumption } from '../../../src/core/semantic-checkpoint.ts';
import { worldValueDigest, type WorldModelStore } from '../../../src/core/world-model.ts';

const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function migrationAuthorityDigest(input: {
  requiredCapabilities: string[];
  resourceKeys: string[];
}): string {
  const requiredCapabilities = exactCapabilities(input.requiredCapabilities);
  const resourceKeys = normalizedResourceKeys(input.resourceKeys);
  return semanticCheckpointDigest({
    version: 1,
    requiredCapabilities,
    resourceKeys
  });
}

export function assertMigrationCapabilities(input: {
  requiredCapabilities: string[];
  permissions: PermissionProfile;
  supportedCapabilities: string[];
}): string[] {
  const required = exactCapabilities(input.requiredCapabilities);
  const supported = new Set(input.supportedCapabilities);
  for (const capability of required) {
    if (!profileAllows(capability, input.permissions.allowedCapabilities)) {
      throw new OperatorError('SEMANTIC_MIGRATION_CAPABILITY_DENIED', `Capability ${capability} is outside local authority.`);
    }
    if (!supported.has(capability)) {
      throw new OperatorError('SEMANTIC_MIGRATION_CAPABILITY_UNAVAILABLE', `Capability ${capability} is not supported on this device.`);
    }
  }
  return required;
}

export async function verifyMigrationResourceKey(
  resourceKeyInput: string,
  permissions: PermissionProfile,
  requiredCapabilitiesInput: string[]
): Promise<boolean> {
  const resourceKey = bounded(resourceKeyInput, 1024, 'resourceKey');
  const required = exactCapabilities(requiredCapabilitiesInput);
  const allowFamily = (prefixes: string[]) => required.some((capability) => prefixes.some((prefix) => capability.startsWith(prefix)))
    && required.every((capability) => profileAllows(capability, permissions.allowedCapabilities));

  const physical = physicalResource(resourceKey);
  if (physical) {
    if (permissions.allowedRoots.length < 1 || !allowFamily(physical.capabilityPrefixes)) return false;
    try {
      const scope = new PathScope(permissions.allowedRoots);
      await scope.resolveExisting(physical.path);
      return true;
    } catch {
      return false;
    }
  }

  if (resourceKey.startsWith('browser:')) return allowFamily(['browser.']);
  if (resourceKey === 'desktop:windows') return allowFamily(['app.', 'visual.', 'input.']);
  if (resourceKey.startsWith('process:')) return allowFamily(['process.', 'terminal.']);
  if (resourceKey.startsWith('cap:')) {
    const capability = resourceKey.slice('cap:'.length);
    return CAPABILITY.test(capability)
      && required.includes(capability)
      && profileAllows(capability, permissions.allowedCapabilities);
  }
  return false;
}

export async function hashAuthorizedMigrationArtifact(
  filePathInput: string,
  permissions: PermissionProfile
): Promise<{ digest: string; size: number }> {
  if (permissions.allowedRoots.length < 1) throw new OperatorError('SEMANTIC_MIGRATION_ARTIFACT_DENIED', 'No filesystem roots are authorized.');
  const scope = new PathScope(permissions.allowedRoots);
  return await scope.withExisting(bounded(filePathInput, 4096, 'artifact path'), async (resolved) => {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OperatorError('SEMANTIC_MIGRATION_ARTIFACT_DENIED', 'Migration artifacts must be regular files.');
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new OperatorError('SEMANTIC_MIGRATION_ARTIFACT_DENIED', 'Migration artifact size is invalid.');
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(resolved, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
    return { digest: hash.digest('hex'), size: stat.size };
  });
}

export async function buildMigrationArtifacts(
  artifactsInput: Array<{ key: string; path: string }>,
  permissions: PermissionProfile
): Promise<SemanticCheckpointArtifact[]> {
  if (!Array.isArray(artifactsInput) || artifactsInput.length > 5000) {
    throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'artifacts must contain at most 5000 entries.');
  }
  const seen = new Set<string>();
  const artifacts: SemanticCheckpointArtifact[] = [];
  for (const [index, item] of artifactsInput.entries()) {
    const key = bounded(item?.key, 1024, `artifacts[${index}].key`);
    if (seen.has(key)) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'Artifact keys must be unique.');
    seen.add(key);
    const proof = await hashAuthorizedMigrationArtifact(item?.path, permissions);
    artifacts.push({ key, digest: proof.digest, size: proof.size });
  }
  return artifacts.sort((a, b) => a.key.localeCompare(b.key));
}

export async function buildMigrationWorldAssumptions(
  assumptionsInput: Array<{ entityKey: string; factKey: string }>,
  world: WorldModelStore
): Promise<SemanticWorldAssumption[]> {
  if (!Array.isArray(assumptionsInput) || assumptionsInput.length > 5000) {
    throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'worldAssumptions must contain at most 5000 entries.');
  }
  const assumptions: SemanticWorldAssumption[] = [];
  const seen = new Set<string>();
  for (const [index, item] of assumptionsInput.entries()) {
    const entityKey = bounded(item?.entityKey, 512, `worldAssumptions[${index}].entityKey`);
    const factKey = bounded(item?.factKey, 128, `worldAssumptions[${index}].factKey`);
    const identity = `${entityKey}\0${factKey}`;
    if (seen.has(identity)) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'World assumptions must be unique.');
    seen.add(identity);
    const fact = await world.resolveFact(entityKey, factKey);
    if (fact.status !== 'resolved') {
      throw new OperatorError('SEMANTIC_MIGRATION_WORLD_UNRESOLVED', `World assumption ${entityKey}.${factKey} is ${fact.status}.`);
    }
    assumptions.push({ entityKey, factKey, valueDigest: worldValueDigest(fact.value) });
  }
  return assumptions.sort((a, b) => `${a.entityKey}\0${a.factKey}`.localeCompare(`${b.entityKey}\0${b.factKey}`));
}

export async function verifyMigrationWorldAssumption(
  assumption: SemanticWorldAssumption,
  world: WorldModelStore
): Promise<string | undefined> {
  const fact = await world.resolveFact(assumption.entityKey, assumption.factKey);
  return fact.status === 'resolved' ? worldValueDigest(fact.value) : undefined;
}

function physicalResource(resourceKey: string): { path: string; capabilityPrefixes: string[] } | undefined {
  for (const [prefix, families] of [
    ['file:', ['file.']],
    ['repo:', ['git.', 'project.']],
    ['workspace:', ['terminal.', 'project.']],
    ['docker:', ['docker.']]
  ] as const) {
    if (resourceKey.startsWith(prefix)) {
      const target = resourceKey.slice(prefix.length);
      return target ? { path: target, capabilityPrefixes: [...families] } : undefined;
    }
  }
  if (resourceKey.startsWith('database:')) {
    const value = resourceKey.slice('database:'.length);
    const split = value.lastIndexOf(':');
    const root = split > 0 ? value.slice(0, split) : value;
    return root ? { path: root, capabilityPrefixes: ['postgres.'] } : undefined;
  }
  return undefined;
}

function profileAllows(capability: string, allowed: readonly string[]): boolean {
  return allowed.some((rule) => rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1))));
}

function exactCapabilities(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 2048) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'requiredCapabilities is invalid.');
  const values = input.map((item, index) => {
    const value = bounded(item, 256, `requiredCapabilities[${index}]`);
    if (!CAPABILITY.test(value) || value.includes('*')) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'Migration capabilities must be exact capability names.');
    return value;
  });
  if (new Set(values).size !== values.length) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'Migration capabilities contain duplicates.');
  return values.sort();
}

function normalizedResourceKeys(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 5000) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'resourceKeys is invalid.');
  const values = input.map((item, index) => bounded(item, 1024, `resourceKeys[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', 'resourceKeys contain duplicates.');
  return values.sort();
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0')) {
    throw new OperatorError('SEMANTIC_MIGRATION_INPUT_INVALID', `${label} is invalid.`);
  }
  return input;
}
