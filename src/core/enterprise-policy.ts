import path from 'node:path';
import { OperatorError } from './errors.ts';
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

interface EnterprisePolicyState {
  version: 1;
  roles: EnterpriseRole[];
  bindings: EnterpriseBinding[];
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

  async configure(input: { roles: EnterpriseRole[]; bindings: EnterpriseBinding[] }): Promise<void> {
    const state = validateState({ version: 1, roles: input.roles, bindings: input.bindings });
    const run = this.#serial.then(() => writeDurableStateText(this.#file, JSON.stringify(state, null, 2), STORE_OPTIONS));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
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
    const context = normalizeContext(contextInput);
    const matches = state.bindings
      .filter((binding) => binding.enabled && binding.principalId === context.principalId)
      .filter((binding) => !binding.teamId || context.teamIds.includes(binding.teamId))
      .filter((binding) => !binding.projectPrefix || (context.projectKey?.startsWith(binding.projectPrefix) ?? false))
      .filter((binding) => !binding.environment || binding.environment === context.environment)
      .filter((binding) => !binding.deviceGroup || context.deviceGroups.includes(binding.deviceGroup))
      .filter((binding) => !binding.deviceId || binding.deviceId === context.deviceId);

    if (matches.length === 0) throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'No enterprise role binding authorizes this context.');

    const grants = matches.map((binding) => ({ binding, role: state.roles.find((role) => role.id === binding.roleId) }))
      .filter((entry): entry is { binding: EnterpriseBinding; role: EnterpriseRole } => Boolean(entry.role))
      .filter(({ role }) => role.environments.length === 0 || (context.environment ? role.environments.includes(context.environment) : false))
      .filter(({ role }) => role.projectPrefixes.length === 0 || (context.projectKey ? role.projectPrefixes.some((prefix) => context.projectKey!.startsWith(prefix)) : false))
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
    const permissions: PermissionProfile = {
      ...base,
      allowedCapabilities,
      allowedRoots,
      maxRisk,
      allowExternalWrites: base.allowExternalWrites === true && RISK_ORDER[maxRisk] >= RISK_ORDER.external,
      allowSystemChanges: base.allowSystemChanges === true && RISK_ORDER[maxRisk] >= RISK_ORDER.system,
      allowDestructive: base.allowDestructive === true && RISK_ORDER[maxRisk] >= RISK_ORDER.destructive
    };
    return {
      roleIds: roles.map((role) => role.id).sort(),
      bindingIds: grants.map(({ binding }) => binding.id).sort(),
      permissions
    };
  }

  async #read(): Promise<EnterprisePolicyState> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, STORE_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, roles: [], bindings: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state could not be read.');
    }
  }
}

function validateState(input: EnterprisePolicyState): EnterprisePolicyState {
  if (!input || input.version !== 1 || !Array.isArray(input.roles) || input.roles.length > MAX_ROLES || !Array.isArray(input.bindings) || input.bindings.length > MAX_BINDINGS) {
    throw new OperatorError('ENTERPRISE_POLICY_CORRUPT', 'Enterprise policy state shape is invalid.');
  }
  const roleIds = new Set<string>();
  const roles = input.roles.map((role, index) => {
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
  const bindings = input.bindings.map((binding, index) => {
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
  return { version: 1, roles, bindings };
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

function intersectRoots(baseRoots: string[], enterpriseRoots: string[]): string[] {
  const base = baseRoots.map((root) => path.resolve(root));
  if (enterpriseRoots.length === 0) return union(base);
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
