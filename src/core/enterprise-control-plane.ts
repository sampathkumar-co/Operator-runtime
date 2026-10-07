import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { assertAttenuates, type AuthorityGrant } from './principal-delegation.ts';
import type { EnterprisePolicySimulationResult } from './enterprise-policy-simulation.ts';
import { OperatorError } from './errors.ts';
import type { ActionRisk } from './types.ts';

export type EnterpriseIdentityProvider = 'oidc' | 'saml' | 'scim';

export interface EnterpriseIdentityMapping {
  schemaVersion: 1;
  id: string;
  provider: EnterpriseIdentityProvider;
  externalSubject: string;
  principalId: string;
  groups: string[];
  active: boolean;
  observedAt: string;
}

export interface OrganizationEmergencyState {
  schemaVersion: 1;
  organizationId: string;
  epoch: number;
  halted: boolean;
  changedAt: string;
  reasonCode?: string;
}

export interface PurposeBoundAuthorityLease {
  schemaVersion: 1;
  id: string;
  organizationId: string;
  principalId: string;
  delegationId: string;
  purpose: string;
  grant: AuthorityGrant;
  issuedAt: string;
  expiresAt: string;
  emergencyEpoch: number;
  approverPrincipalIds: string[];
  requiredApprovalQuorum: number;
}

export interface EnterpriseAuthorityPath {
  schemaVersion: 1;
  principalId: string;
  leaseId: string;
  delegationId: string;
  purpose: string;
  authorityDigest: string;
  approverPrincipalIds: string[];
  expiresAt: string;
  emergencyEpoch: number;
}

export interface EnterprisePolicyRolloutDelta {
  schemaVersion: 1;
  totalCases: number;
  unchanged: number;
  newlyAllowed: string[];
  newlyDenied: string[];
  changedDenialCode: string[];
}

const MAX_ID = 256;
const MAX_GROUPS = 512;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const RISK_ORDER: Record<ActionRisk, number> = { read: 0, write: 1, external: 2, system: 3, destructive: 4 };

export function createEnterpriseIdentityMapping(input: {
  provider: EnterpriseIdentityProvider;
  externalSubject: string;
  principalId: string;
  groups?: string[];
  active?: boolean;
  observedAt?: string;
}): EnterpriseIdentityMapping {
  const normalized = {
    schemaVersion: 1 as const,
    provider: provider(input.provider),
    externalSubject: boundedText(input.externalSubject, 1024, 'externalSubject'),
    principalId: id(input.principalId, 'principalId'),
    groups: uniqueIds(input.groups ?? [], MAX_GROUPS, 'groups'),
    active: input.active ?? true,
    observedAt: iso(input.observedAt ?? new Date().toISOString(), 'observedAt')
  };
  if (typeof normalized.active !== 'boolean') throw invalid('active must be boolean.');
  return { ...normalized, id: sha256(canonicalJson(normalized)) };
}

export function createOrganizationEmergencyState(input: {
  organizationId: string;
  epoch?: number;
  halted?: boolean;
  changedAt?: string;
  reasonCode?: string;
}): OrganizationEmergencyState {
  const epoch = integer(input.epoch ?? 1, 1, Number.MAX_SAFE_INTEGER, 'epoch');
  const halted = input.halted ?? false;
  if (typeof halted !== 'boolean') throw invalid('halted must be boolean.');
  return {
    schemaVersion: 1,
    organizationId: id(input.organizationId, 'organizationId'),
    epoch,
    halted,
    changedAt: iso(input.changedAt ?? new Date().toISOString(), 'changedAt'),
    ...(input.reasonCode ? { reasonCode: reason(input.reasonCode) } : {})
  };
}

export function transitionOrganizationEmergencyState(
  currentInput: OrganizationEmergencyState,
  input: { halted: boolean; changedAt?: string; reasonCode?: string }
): OrganizationEmergencyState {
  const current = normalizeEmergencyState(currentInput);
  if (typeof input.halted !== 'boolean') throw invalid('halted must be boolean.');
  if (current.epoch >= Number.MAX_SAFE_INTEGER) throw invalid('Emergency epoch is exhausted.');
  return createOrganizationEmergencyState({
    organizationId: current.organizationId,
    epoch: current.epoch + 1,
    halted: input.halted,
    changedAt: input.changedAt ?? new Date().toISOString(),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {})
  });
}

export function issuePurposeBoundAuthorityLease(input: {
  organizationId: string;
  principalId: string;
  delegationId: string;
  purpose: string;
  parentGrant: AuthorityGrant;
  grant: AuthorityGrant;
  emergencyState: OrganizationEmergencyState;
  approverPrincipalIds?: string[];
  requiredApprovalQuorum?: number;
  issuedAt?: string;
  expiresAt: string;
  maxLeaseMs?: number;
}): PurposeBoundAuthorityLease {
  const emergency = normalizeEmergencyState(input.emergencyState);
  if (emergency.halted) throw invalid('Organization emergency halt blocks new authority leases.');
  const organizationId = id(input.organizationId, 'organizationId');
  if (emergency.organizationId !== organizationId) throw invalid('Emergency state organization does not match the lease.');
  const principalId = id(input.principalId, 'principalId');
  const delegationId = id(input.delegationId, 'delegationId');
  const purpose = boundedText(input.purpose, 2048, 'purpose');
  assertAttenuates(input.parentGrant, input.grant, 'purpose-bound lease');
  const grant = normalizeGrant(input.grant);
  const issuedAt = iso(input.issuedAt ?? new Date().toISOString(), 'issuedAt');
  const expiresAt = iso(input.expiresAt, 'expiresAt');
  const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
  const maxLeaseMs = integer(input.maxLeaseMs ?? MAX_LEASE_MS, 10_000, MAX_LEASE_MS, 'maxLeaseMs');
  if (duration <= 0 || duration > maxLeaseMs) throw invalid('Authority lease lifetime is invalid.');
  if (input.parentGrant.expiresAt && Date.parse(expiresAt) > Date.parse(iso(input.parentGrant.expiresAt, 'parentGrant.expiresAt'))) {
    throw invalid('Authority lease outlives its parent grant.');
  }

  const approverPrincipalIds = uniqueIds(input.approverPrincipalIds ?? [], 32, 'approverPrincipalIds');
  if (approverPrincipalIds.includes(principalId)) throw invalid('Lease principal cannot approve its own elevation.');
  const requiredApprovalQuorum = integer(input.requiredApprovalQuorum ?? minimumQuorum(grant.maxRisk), 0, 32, 'requiredApprovalQuorum');
  const minQuorum = minimumQuorum(grant.maxRisk);
  if (requiredApprovalQuorum < minQuorum) throw invalid('Approval quorum is below the risk minimum.');
  if (approverPrincipalIds.length < requiredApprovalQuorum) throw invalid('Approval quorum is not satisfied.');

  const identity = {
    schemaVersion: 1 as const,
    organizationId,
    principalId,
    delegationId,
    purpose,
    grant,
    issuedAt,
    expiresAt,
    emergencyEpoch: emergency.epoch,
    approverPrincipalIds,
    requiredApprovalQuorum
  };
  return { ...identity, id: sha256(canonicalJson(identity)) };
}

export function validatePurposeBoundAuthorityLease(input: PurposeBoundAuthorityLease): PurposeBoundAuthorityLease {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') throw invalid('Authority lease shape is invalid.');
  const normalized = issuePurposeBoundAuthorityLease({
    organizationId: input.organizationId,
    principalId: input.principalId,
    delegationId: input.delegationId,
    purpose: input.purpose,
    parentGrant: input.grant,
    grant: input.grant,
    emergencyState: createOrganizationEmergencyState({
      organizationId: input.organizationId,
      epoch: input.emergencyEpoch,
      halted: false,
      changedAt: input.issuedAt
    }),
    approverPrincipalIds: input.approverPrincipalIds,
    requiredApprovalQuorum: input.requiredApprovalQuorum,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    maxLeaseMs: MAX_LEASE_MS
  });
  if (normalized.id !== input.id) throw invalid('Authority lease id does not match its content.');
  return normalized;
}

export function assertPurposeBoundAuthorityLeaseUsable(input: {
  lease: PurposeBoundAuthorityLease;
  emergencyState: OrganizationEmergencyState;
  now?: string;
  capability?: string;
  resource?: string;
  risk?: ActionRisk;
}): EnterpriseAuthorityPath {
  const lease = validatePurposeBoundAuthorityLease(input.lease);
  const emergency = normalizeEmergencyState(input.emergencyState);
  if (emergency.organizationId !== lease.organizationId) throw invalid('Emergency state organization does not match the lease.');
  if (emergency.halted) throw new OperatorError('ENTERPRISE_EMERGENCY_HALT', 'Organization emergency halt invalidates execution authority.');
  if (emergency.epoch !== lease.emergencyEpoch) throw new OperatorError('ENTERPRISE_AUTHORITY_STALE', 'Authority lease predates the current organization emergency epoch.', { retryable: true });
  const now = iso(input.now ?? new Date().toISOString(), 'now');
  if (Date.parse(now) < Date.parse(lease.issuedAt) || Date.parse(now) >= Date.parse(lease.expiresAt)) {
    throw new OperatorError('ENTERPRISE_AUTHORITY_EXPIRED', 'Purpose-bound authority lease is not active.');
  }
  if (input.capability && !lease.grant.capabilities.some((rule) => matchesCapability(input.capability!, rule))) {
    throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Purpose-bound authority lease does not grant the requested capability.');
  }
  if (input.resource && lease.grant.resourcePrefixes.length > 0 && !lease.grant.resourcePrefixes.some((prefix) => withinPrefix(input.resource!, prefix))) {
    throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Purpose-bound authority lease does not grant the requested resource.');
  }
  if (input.risk && RISK_ORDER[input.risk] > RISK_ORDER[lease.grant.maxRisk]) {
    throw new OperatorError('ENTERPRISE_AUTHORITY_DENIED', 'Purpose-bound authority lease risk ceiling is exceeded.');
  }
  const authorityDigest = sha256(canonicalJson({
    leaseId: lease.id,
    organizationId: lease.organizationId,
    principalId: lease.principalId,
    purpose: lease.purpose,
    grant: lease.grant,
    emergencyEpoch: lease.emergencyEpoch
  }));
  return {
    schemaVersion: 1,
    principalId: lease.principalId,
    leaseId: lease.id,
    delegationId: lease.delegationId,
    purpose: lease.purpose,
    authorityDigest,
    approverPrincipalIds: [...lease.approverPrincipalIds],
    expiresAt: lease.expiresAt,
    emergencyEpoch: lease.emergencyEpoch
  };
}

export function compareEnterprisePolicySimulation(
  beforeInput: EnterprisePolicySimulationResult[],
  afterInput: EnterprisePolicySimulationResult[]
): EnterprisePolicyRolloutDelta {
  if (!Array.isArray(beforeInput) || !Array.isArray(afterInput) || beforeInput.length > 100_000 || afterInput.length > 100_000) {
    throw invalid('Policy simulation collections are invalid.');
  }
  const before = normalizeSimulation(beforeInput);
  const after = normalizeSimulation(afterInput);
  if (before.size !== after.size || [...before.keys()].some((key) => !after.has(key))) {
    throw invalid('Policy simulation cohorts must contain the same case IDs.');
  }
  const newlyAllowed: string[] = [];
  const newlyDenied: string[] = [];
  const changedDenialCode: string[] = [];
  let unchanged = 0;
  for (const [caseId, left] of before) {
    const right = after.get(caseId)!;
    if (left.allowed === right.allowed && left.deniedCode === right.deniedCode) {
      unchanged += 1;
      continue;
    }
    if (!left.allowed && right.allowed) newlyAllowed.push(caseId);
    else if (left.allowed && !right.allowed) newlyDenied.push(caseId);
    else changedDenialCode.push(caseId);
  }
  return {
    schemaVersion: 1,
    totalCases: before.size,
    unchanged,
    newlyAllowed: newlyAllowed.sort(),
    newlyDenied: newlyDenied.sort(),
    changedDenialCode: changedDenialCode.sort()
  };
}

function normalizeSimulation(input: EnterprisePolicySimulationResult[]): Map<string, EnterprisePolicySimulationResult> {
  const map = new Map<string, EnterprisePolicySimulationResult>();
  for (const row of input) {
    const caseId = id(row.id, 'simulation.id');
    if (map.has(caseId)) throw invalid('Policy simulation contains duplicate case IDs.');
    if (typeof row.allowed !== 'boolean' || !Array.isArray(row.roleIds) || !Array.isArray(row.bindingIds)) throw invalid('Policy simulation result is invalid.');
    map.set(caseId, { ...row, id: caseId });
  }
  return map;
}

function normalizeEmergencyState(input: OrganizationEmergencyState): OrganizationEmergencyState {
  if (!input || input.schemaVersion !== 1) throw invalid('Emergency state is invalid.');
  return createOrganizationEmergencyState(input);
}

function normalizeGrant(input: AuthorityGrant): AuthorityGrant {
  if (!input || typeof input !== 'object') throw invalid('Authority grant is invalid.');
  if (!['read','write','external','system','destructive'].includes(input.maxRisk)) throw invalid('Authority grant maxRisk is invalid.');
  return {
    capabilities: uniqueIds(input.capabilities, 1024, 'grant.capabilities'),
    resourcePrefixes: uniqueIds(input.resourcePrefixes, 1024, 'grant.resourcePrefixes'),
    maxRisk: input.maxRisk,
    ...(input.expiresAt ? { expiresAt: iso(input.expiresAt, 'grant.expiresAt') } : {})
  };
}

function minimumQuorum(risk: ActionRisk): number {
  if (risk === 'system' || risk === 'destructive') return 2;
  if (risk === 'external') return 1;
  return 0;
}

function matchesCapability(capability: string, rule: string): boolean {
  return rule === '*' || rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1)));
}

function withinPrefix(resource: string, prefix: string): boolean {
  return resource === prefix || resource.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

function provider(input: unknown): EnterpriseIdentityProvider {
  if (!['oidc','saml','scim'].includes(String(input))) throw invalid('Identity provider is invalid.');
  return input as EnterpriseIdentityProvider;
}

function uniqueIds(input: unknown, max: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw invalid(label + ' is invalid.');
  const values = input.map((value) => id(value, label));
  return [...new Set(values)].sort();
}

function id(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > MAX_ID || !/^[A-Za-z0-9._:@/+-=*]+$/.test(value)) throw invalid(label + ' is invalid.');
  return value;
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maxBytes) throw invalid(label + ' is invalid.');
  return input.trim();
}

function reason(input: unknown): string {
  const value = String(input ?? '');
  if (!/^[A-Z0-9_:-]{1,128}$/.test(value)) throw invalid('reasonCode is invalid.');
  return value;
}

function iso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid(label + ' must be canonical ISO.');
  return value;
}

function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(label + ' is invalid.');
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalid(message: string): OperatorError {
  return new OperatorError('ENTERPRISE_CONTROL_PLANE_INVALID', message);
}
