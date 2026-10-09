import crypto from 'node:crypto';
import type { ActionRequest, PermissionProfile } from '../../../src/core/types.ts';
import { canonicalJson } from '../../../src/core/action-identity.ts';
import type { ApprovalAuthorityContext, ApprovalRecord } from './approval-store.ts';
import { approvalAuthorityFingerprint } from './approval-store.ts';

const MAX_SESSION_MS = 8 * 60 * 60_000;
const IDLE_SESSION_MS = 60 * 60_000;
// Session approval attenuates to the risk class explicitly approved by the
// user; approving an external action never grants system/destructive authority.
const RISK_RANK: Record<ActionRequest['risk'], number> = { read: 0, write: 1, external: 2, system: 3, destructive: 4 };
const riskRank = (risk: ActionRequest['risk']): number => RISK_RANK[risk];

export type SessionApprovalGrant = {
  id: string;
  authorityHash: string;
  scopeHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  idleExpiresAt: string;
  sourceActionId: string;
  maxApprovedRisk: 'external' | 'system' | 'destructive';
};

export type SessionApprovalSummary = {
  active: boolean;
  id?: string;
  createdAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  idleExpiresAt?: string;
};

export class SessionApprovalStore {
  #grant: SessionApprovalGrant | null = null;
  #clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  grant(record: ApprovalRecord, permissions: PermissionProfile): SessionApprovalGrant {
    if (record.status !== 'approved') throw new Error('Session approval requires an approved action record.');
    if (!['external', 'system', 'destructive'].includes(record.risk)) {
      throw new Error('Session approval can only be created from a risk-gated action.');
    }
    const now = this.#clock();
    const grant: SessionApprovalGrant = {
      id: crypto.randomUUID(),
      authorityHash: record.authorityHash,
      scopeHash: permissionScopeFingerprint(permissions),
      createdAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + MAX_SESSION_MS).toISOString(),
      idleExpiresAt: new Date(now.getTime() + IDLE_SESSION_MS).toISOString(),
      sourceActionId: record.actionId,
      maxApprovedRisk: record.risk as SessionApprovalGrant['maxApprovedRisk']
    };
    this.#grant = grant;
    return { ...grant };
  }

  summary(): SessionApprovalSummary {
    this.#prune();
    if (!this.#grant) return { active: false };
    const { id, createdAt, lastUsedAt, expiresAt, idleExpiresAt } = this.#grant;
    return { active: true, id, createdAt, lastUsedAt, expiresAt, idleExpiresAt };
  }

  allows(
    action: ActionRequest,
    authority: ApprovalAuthorityContext | undefined,
    permissions: PermissionProfile
  ): boolean {
    this.#prune();
    const grant = this.#grant;
    if (!grant) return false;
    if (grant.authorityHash !== approvalAuthorityFingerprint(authority)) return false;
    if (grant.scopeHash !== permissionScopeFingerprint(permissions)) return false;
    if (riskRank(action.risk) > riskRank(grant.maxApprovedRisk)) return false;
    const now = this.#clock();
    grant.lastUsedAt = now.toISOString();
    grant.idleExpiresAt = new Date(now.getTime() + IDLE_SESSION_MS).toISOString();
    return true;
  }

  permissionsFor(
    authority: ApprovalAuthorityContext | undefined,
    permissions: PermissionProfile
  ): PermissionProfile {
    this.#prune();
    const grant = this.#grant;
    if (!grant) return permissions;
    if (grant.authorityHash !== approvalAuthorityFingerprint(authority)) return permissions;
    if (grant.scopeHash !== permissionScopeFingerprint(permissions)) return permissions;
    const now = this.#clock();
    grant.lastUsedAt = now.toISOString();
    grant.idleExpiresAt = new Date(now.getTime() + IDLE_SESSION_MS).toISOString();
    return {
      ...permissions,
      allowExternalWrites: Boolean(permissions.allowExternalWrites) || riskRank(grant.maxApprovedRisk) >= riskRank('external'),
      allowSystemChanges: Boolean(permissions.allowSystemChanges) || riskRank(grant.maxApprovedRisk) >= riskRank('system'),
      allowDestructive: Boolean(permissions.allowDestructive) || riskRank(grant.maxApprovedRisk) >= riskRank('destructive')
    };
  }

  clear(): void {
    this.#grant = null;
  }

  #prune(): void {
    const grant = this.#grant;
    if (!grant) return;
    const now = this.#clock().getTime();
    if (Date.parse(grant.expiresAt) <= now || Date.parse(grant.idleExpiresAt) <= now) this.#grant = null;
  }
}

function permissionScopeFingerprint(permissions: PermissionProfile): string {
  return crypto.createHash('sha256').update(canonicalJson({
    allowedCapabilities: [...permissions.allowedCapabilities].sort(),
    allowedRoots: [...permissions.allowedRoots].sort(),
    enterprisePolicyDigest: permissions.enterprisePolicyDigest ?? null,
    enterprisePolicyGeneration: permissions.enterprisePolicyGeneration ?? null
  }), 'utf8').digest('hex');
}
