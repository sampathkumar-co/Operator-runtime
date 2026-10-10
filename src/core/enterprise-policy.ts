import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import type { ActionRisk, PermissionProfile } from './types.ts';

export interface EnterpriseRole {
  id: string;
  capabilities: string[];
  rootPrefixes: string[];
  maxRisk: ActionRisk;
  environments: string[];
  projectPrefixes: string[];
  deviceGroups: string[];
  deviceIds?: string[];
}

export interface EnterpriseBinding {
  id: string;
  principalId: string;
  roleId: string;
  teamId?: string;
  projectPrefix?: string;
  environment?: string;
  deviceGroup?: string;
  deviceId?: string;
  enabled: boolean;
}

export interface EnterpriseAuthorizationContext {
  principalId: string;
  teamIds?: string[];
  projectKey?: string;
  environment?: string;
  deviceId?: string;
  deviceGroups?: string[];
}

export interface EnterprisePolicyState {
  version: 2;
  generation: number;
  roles: EnterpriseRole[];
  bindings: EnterpriseBinding[];
  recordDigest: string;
}

export interface EnterprisePermissionDecision {
  roleIds: string[];
  bindingIds: string[];
  permissions: PermissionProfile;
}

const MAX_ROLES = 1000;
const MAX_BINDINGS = 20_000;
const RISK_ORDER: Record<ActionRisk, number> = { read: 0, write: 1, external: 2, system: 3, destructive: 4 };
const STORE_OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'ENTERPRISE_POLICY_CORRUPT',
  invalidMessage: 'Enterprise policy state is invalid.'
} as const;

export class EnterprisePolicyStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'enterprise-policy.json');
  }

  async configure(input: { roles: EnterpriseRole[]; bindings: EnterpriseBinding[] }): Promise<EnterprisePolicyState> {
    const policy = validatePolicy(input.roles, input.bindings);
    let configured!: EnterprisePolicyState;
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const current = await this.#read();
      if (enterprisePolicyDigest(current) === enterprisePolicyDigest(policy)) {
        configured = current;
        return;
      }
      if (current.generation >= Number.MAX_SAFE_INTEGER) {
        throw new OperatorError('ENTERPRISE_POLICY_GENERATION_EXHAUSTED', 'Enterprise policy generation cannot advance safely.');
      }
      configured = sealState({ version: 2, generation: current.generation + 1, roles: policy.roles, bindings: policy.bindings });
      await writeDurableStateText(this.#file, JSON.stringify(configured, null, 2), STORE_OPTIONS);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(configured);
  }

  async inspect(): Promise<EnterprisePolicyState> {
    await this.#serial;
    return structuredClone(await this.#read());
  }

  async isConfigured(): Promise<boolean> {
    await this.#serial;
    const state = await this.#read();
    return state.roles.length > 0 || state.bindings.length > 0;
  }

  async narrow(base: PermissionProfile, contextInput: EnterpriseAuthorizationContext): Promise<EnterprisePermissionDecision> {
    await this.#serial;
    const state = await this.#read();
    const policyDigest = enterprisePolicyDigest(state);
    const context = normalizeContext(contextInput);
    const matches = state.bindings
      .filter((binding) => binding.enabled && binding.principalId === context.principalId)
      .filter((binding) => !binding.teamId || context.teamIds.includes(binding.teamId))
      .filter((binding) => !binding.projectPrefix || (context.projectKey ? withinProjectPrefix(context.projectKey, binding.projectPrefix) : false))
      .filter((binding) => !binding.environment || binding.environment === context.environment)
      .filter((binding) => !binding.deviceGroup || context.deviceGroups.includes(binding.deviceGroup))
      .filter((binding) => !binding.deviceId || binding.deviceId === context.deviceId);

    if (matches.length === 0) throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'No enterprise role binding authorizes this context.');

    const grants = matches.map((binding) => ({ binding, role: state.roles.find((role) => role.id === binding.roleId) }))
      .filter((entry): entry is { binding: EnterpriseBinding; role: EnterpriseRole } => Boolean(entry.role))
      .filter(({ role }) => role.environments.length === 0 || (context.environment ? role.environments.includes(context.environment) : false))
      .filter(({ role }) => role.projectPrefixes.length === 0 || (context.projectKey ? role.projectPrefixes.some((prefix) => withinProjectPrefix(context.projectKey!, prefix)) : false))
      .filter(({ role }) => role.deviceGroups.length === 0 || role.deviceGroups.some((group) => context.deviceGroups.includes(group)))
      .filter(({ role }) => (role.deviceIds ?? []).length === 0 || (context.deviceId ? role.deviceIds!.includes(context.deviceId) : false));

    if (grants.length === 0) throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Enterprise role constraints do not authorize this context.');

    const roles = [...new Map(grants.map(({ role }) => [role.id, role])).values()];
    const enterpriseCapabilities = union(roles.flatMap((role) => role.capabilities));
    const allowedCapabilities = intersectCapabilities(base.allowedCapabilities, enterpriseCapabilities);
    if (allowedCapabilities.length === 0) throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Enterprise policy intersection grants no capabilities.');

    const rootPrefixes = union(roles.flatMap((role) => role.rootPrefixes)).map((root) => path.resolve(root));
    const allowedRoots = intersectRoots(base.allowedRoots, rootPrefixes);
    if (base.allowedRoots.length > 0 && rootPrefixes.length > 0 && allowedRoots.length === 0) {
      throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Enterprise policy intersection grants no filesystem roots.');
    }

    const roleMaxRisk = roles.reduce<ActionRisk>((current, role) =>
      RISK_ORDER[role.maxRisk] > RISK_ORDER[current] ? role.maxRisk : current, 'read');
    const baseMaxRisk = base.maxRisk ?? 'destructive';
    const maxRisk = RISK_ORDER[roleMaxRisk] <= RISK_ORDER[baseMaxRisk] ? roleMaxRisk : baseMaxRisk;
    assertRoleProjectionSafe(roles, allowedCapabilities, allowedRoots, maxRisk);
    const permissions: PermissionProfile = {
      ...base,
      allowedCapabilities,
      allowedRoots,
      maxRisk,
      allowExternalWrites: base.allowExternalWrites === true && RISK_ORDER[maxRisk] >= RISK_ORDER.external,
      allowSystemChanges: base.allowSystemChanges === true && RISK_ORDER[maxRisk] >= RISK_ORDER.system,
      allowDestructive: base.allowDestructive === true && RISK_ORDER[maxRisk] >= RISK_ORDER.destructive,
      enterprisePolicyDigest: policyDigest,
      enterprisePolicyGeneration: state.generation
    };
    return {
      roleIds: roles.map((role) => role.id).sort(),
      bindingIds: grants.map(({ binding }) => binding.id).sort(),
      permissions
    };
  }

  async currentDigest(): Promise<string> {
    await this.#serial;
    return enterprisePolicyDigest(await this.#read());
  }

  async currentAuthority(): Promise<{ digest: string; generation: number }> {
    await this.#serial;
    const state = await this.#read();
    return { digest: enterprisePolicyDigest(state), generation: state.generation };
  }

  async assertCurrentAuthority(expectedInput: { digest: string; generation: number }): Promise<void> {
    if (typeof expectedInput?.digest !== 'string' || typeof expectedInput.generation !== 'number') {
      throw new OperatorError('ENTERPRISE_POLICY_AUTHORITY_INVALID', 'Enterprise policy digest or generation is invalid.');
    }
    const expectedDigest = expectedInput.digest.toLowerCase();
    const expectedGeneration = expectedInput.generation;
    if (!/^[0-9a-f]{64}$/.test(expectedDigest) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw new OperatorError('ENTERPRISE_POLICY_AUTHORITY_INVALID', 'Enterprise policy digest or generation is invalid.');
    }
    const actual = await this.currentAuthority();
    if (actual.digest !== expectedDigest || actual.generation !== expectedGeneration) {
      throw new OperatorError('ENTERPRISE_POLICY_STALE', 'Enterprise policy changed after authority was derived; permissions must be recomputed.', {
        retryable: true,
        details: {
          expectedDigest, actualDigest: actual.digest,
          expectedGeneration, actualGeneration: actual.generation,
          sideEffectState: 'none', executionPhase: 'pre_dispatch'
        }
      });
    }
  }

  async #read(): Promise<EnterprisePolicyState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sealState({ version: 2, generation: 0, roles: [], bindings: [] });
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state could not be read.');
    }
  }
}

function validateState(input: unknown): EnterprisePolicyState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state shape is invalid.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.version === 1) {
    if (Object.keys(raw).some((key) => !['version', 'roles', 'bindings'].includes(key))) {
      throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Legacy enterprise policy contains unexpected fields.');
    }
    const legacy = validatePolicy(raw.roles, raw.bindings);
    return sealState({ version: 2, generation: 1, roles: legacy.roles, bindings: legacy.bindings });
  }
  if (Object.keys(raw).some((key) => !['version', 'generation', 'roles', 'bindings', 'recordDigest'].includes(key))
    || raw.version !== 2 || typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation < 0
    || typeof raw.recordDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.recordDigest.toLowerCase())) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state shape is invalid.');
  }
  const policy = validatePolicy(raw.roles, raw.bindings);
  const state = { version: 2 as const, generation: raw.generation, roles: policy.roles, bindings: policy.bindings, recordDigest: raw.recordDigest.toLowerCase() };
  if (state.recordDigest !== enterprisePolicyRecordDigest(state)) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy generation or content integrity check failed.');
  }
  if (state.generation === 0 && (state.roles.length > 0 || state.bindings.length > 0)) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Configured enterprise policy requires a positive generation.');
  }
  return state;
}

function validatePolicy(rolesInput: unknown, bindingsInput: unknown): Pick<EnterprisePolicyState, 'roles' | 'bindings'> {
  if (!Array.isArray(rolesInput) || rolesInput.length > MAX_ROLES || !Array.isArray(bindingsInput) || bindingsInput.length > MAX_BINDINGS) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state shape is invalid.');
  }
  const roleIds = new Set<string>();
  const roles = (rolesInput as EnterpriseRole[]).map((role, index) => {
    const id = idValue(role.id, `roles[${index}].id`);
    if (roleIds.has(id)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise role IDs must be unique.');
    roleIds.add(id);
    return {
      id,
      capabilities: uniquePatterns(role.capabilities, 512, `roles[${index}].capabilities`),
      rootPrefixes: uniqueRoots(role.rootPrefixes, 512, `roles[${index}].rootPrefixes`),
      maxRisk: risk(role.maxRisk),
      environments: uniqueIds(role.environments, 128, `roles[${index}].environments`),
      projectPrefixes: uniqueText(role.projectPrefixes, 512, 512, `roles[${index}].projectPrefixes`),
      deviceGroups: uniqueIds(role.deviceGroups, 256, `roles[${index}].deviceGroups`),
      deviceIds: uniqueText(role.deviceIds ?? [], 512, 256, `roles[${index}].deviceIds`)
    };
  });

  const bindingIds = new Set<string>();
  const bindings = (bindingsInput as EnterpriseBinding[]).map((binding, index) => {
    const id = idValue(binding.id, `bindings[${index}].id`);
    if (bindingIds.has(id)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise binding IDs must be unique.');
    bindingIds.add(id);
    const roleId = idValue(binding.roleId, `bindings[${index}].roleId`);
    if (!roleIds.has(roleId)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `Binding ${id} references an unknown role.`);
    return {
      id,
      principalId: bounded(binding.principalId, 512, `bindings[${index}].principalId`),
      roleId,
      ...(binding.teamId ? { teamId: idValue(binding.teamId, `bindings[${index}].teamId`) } : {}),
      ...(binding.projectPrefix ? { projectPrefix: bounded(binding.projectPrefix, 512, `bindings[${index}].projectPrefix`) } : {}),
      ...(binding.environment ? { environment: idValue(binding.environment, `bindings[${index}].environment`) } : {}),
      ...(binding.deviceGroup ? { deviceGroup: idValue(binding.deviceGroup, `bindings[${index}].deviceGroup`) } : {}),
      ...(binding.deviceId ? { deviceId: bounded(binding.deviceId, 256, `bindings[${index}].deviceId`) } : {}),
      enabled: binding.enabled === true
    };
  });
  return { roles, bindings };
}

function normalizeContext(input: EnterpriseAuthorizationContext) {
  if (!input || typeof input !== 'object') throw new OperatorError('ENTERPRISE_CONTEXT_INVALID', 'Enterprise authorization context is required.');
  return {
    principalId: bounded(input.principalId, 512, 'principalId'),
    teamIds: uniqueIds(input.teamIds ?? [], 256, 'teamIds'),
    projectKey: input.projectKey === undefined ? undefined : bounded(input.projectKey, 512, 'projectKey'),
    environment: input.environment === undefined ? undefined : idValue(input.environment, 'environment'),
    deviceId: input.deviceId === undefined ? undefined : bounded(input.deviceId, 256, 'deviceId'),
    deviceGroups: uniqueIds(input.deviceGroups ?? [], 256, 'deviceGroups')
  };
}

function intersectCapabilities(base: string[], enterprise: string[]): string[] {
  const result = new Set<string>();
  for (const left of base) {
    for (const right of enterprise) {
      const intersection = intersectCapabilityPattern(left, right);
      if (intersection) result.add(intersection);
    }
  }
  return [...result].sort();
}

function intersectCapabilityPattern(left: string, right: string): string | undefined {
  if (left === right) return left;
  const leftWildcard = left.endsWith('.*');
  const rightWildcard = right.endsWith('.*');
  const leftPrefix = leftWildcard ? left.slice(0, -1) : left;
  const rightPrefix = rightWildcard ? right.slice(0, -1) : right;
  if (leftWildcard && !rightWildcard && right.startsWith(leftPrefix)) return right;
  if (!leftWildcard && rightWildcard && left.startsWith(rightPrefix)) return left;
  if (leftWildcard && rightWildcard) {
    if (leftPrefix.startsWith(rightPrefix)) return left;
    if (rightPrefix.startsWith(leftPrefix)) return right;
  }
  return undefined;
}

function assertRoleProjectionSafe(
  roles: EnterpriseRole[], capabilities: string[], roots: string[], risk: ActionRisk
): void {
  if (roles.length < 2) return;
  const targetCount = Math.max(1, roots.length);
  // Fail closed instead of permitting adversarially large O(C * R * roles)
  // checks to exhaust memory or monopolize the authorization request.
  if (capabilities.length * targetCount > 16_384) {
    throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Combined role grant projection exceeds safe validation limits.');
  }
  const targets: Array<string | undefined> = roots.length === 0 ? [undefined] : roots;
  for (const capability of capabilities) {
    const eligible = roles.filter((role) =>
      RISK_ORDER[role.maxRisk] >= RISK_ORDER[risk]
      && role.capabilities.some((pattern) =>
        pattern === capability || (pattern.endsWith('.*') && capability.startsWith(pattern.slice(0, -1)))
      )
    );
    for (const target of targets) {
      if (!eligible.some((role) =>
        target === undefined
          ? role.rootPrefixes.length === 0
          : role.rootPrefixes.length === 0 || role.rootPrefixes.some((prefix) => isWithin(target, path.resolve(prefix)))
      )) {
        throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Combined enterprise roles cannot be flattened without expanding capability, root or risk authority.');
      }
    }
  }
}

function intersectRoots(baseRoots: string[], enterpriseRoots: string[]): string[] {
  const base = baseRoots.map((root) => path.resolve(root));
  if (enterpriseRoots.length === 0) return union(base);
  // In PermissionProfile an empty root list means unrestricted, not denied.
  // Preserve a narrower enterprise boundary instead of returning [] (which
  // would accidentally turn the final policy back into unrestricted access).
  if (base.length === 0) return union(enterpriseRoots.map((root) => path.resolve(root)));
  const result = new Set<string>();
  for (const baseRoot of base) {
    for (const enterpriseRoot of enterpriseRoots) {
      const policyRoot = path.resolve(enterpriseRoot);
      if (isWithin(baseRoot, policyRoot)) result.add(baseRoot);
      else if (isWithin(policyRoot, baseRoot)) result.add(policyRoot);
    }
  }
  return [...result].sort();
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function withinProjectPrefix(projectKey: string, prefix: string): boolean {
  if (projectKey === prefix) return true;
  if (prefix.endsWith(':') || prefix.endsWith('/')) return projectKey.startsWith(prefix);
  return projectKey.startsWith(prefix + ':') || projectKey.startsWith(prefix + '/');
}
function union(values: string[]): string[] { return [...new Set(values)].sort(); }
function risk(input: unknown): ActionRisk {
  if (input !== 'read' && input !== 'write' && input !== 'external' && input !== 'system' && input !== 'destructive') throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Role maxRisk is invalid.');
  return input;
}
function idValue(input: unknown, label: string): string {
  const value = bounded(input, 128, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  return value;
}
function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || input.includes('\0') || /[\r\n]/.test(input)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  return input;
}
function uniqueIds(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  const values = input.map((value, index) => idValue(value, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} contains duplicates.`);
  return values.sort();
}
function uniquePatterns(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  const values = input.map((value, index) => {
    const text = bounded(value, 256, `${label}[${index}]`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\.\*)?$/.test(text)) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label}[${index}] is invalid.`);
    return text;
  });
  if (new Set(values).size !== values.length) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} contains duplicates.`);
  return values.sort();
}
function uniqueRoots(input: unknown, maxItems: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  const values = input.map((value, index) => path.resolve(bounded(value, 4096, `${label}[${index}]`)));
  if (new Set(values).size !== values.length) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} contains duplicates.`);
  return values.sort();
}
function uniqueText(input: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} is invalid.`);
  const values = input.map((value, index) => bounded(value, maxLength, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', `${label} contains duplicates.`);
  return values.sort();
}

function enterprisePolicyDigest(state: Pick<EnterprisePolicyState, 'roles' | 'bindings'>): string {
  const canonical = {
    version: 1,
    roles: [...state.roles].sort((a, b) => a.id.localeCompare(b.id)),
    bindings: [...state.bindings].sort((a, b) => a.id.localeCompare(b.id))
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sealState(input: Omit<EnterprisePolicyState, 'recordDigest'>): EnterprisePolicyState {
  const state = { ...input, recordDigest: '' };
  state.recordDigest = enterprisePolicyRecordDigest(state);
  return state;
}

function enterprisePolicyRecordDigest(state: Pick<EnterprisePolicyState, 'version' | 'generation' | 'roles' | 'bindings'>): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: state.version,
    generation: state.generation,
    policyDigest: enterprisePolicyDigest(state)
  })).digest('hex');
}
