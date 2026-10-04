import crypto from 'node:crypto';
import path from 'node:path';
import { capabilityRiskRule, assertCanonicalRisk } from './capability-policy.ts';
import { PolicyError } from './errors.ts';
import { PolicyEngine } from './policy.ts';
import { normalizeScopedPathSyntax } from './scoped-path-syntax.ts';
import type { ActionRequest, ActionRisk, PermissionProfile } from './types.ts';

const RISK_ORDER: Record<ActionRisk, number> = {
  read: 0,
  write: 1,
  external: 2,
  system: 3,
  destructive: 4
};

export interface CapabilityTokenClaims {
  version: 1;
  tokenId: string;
  capability: string;
  roots: string[];
  maxRisk: ActionRisk;
  actionIds: string[];
  issuedAt: string;
  expiresAt: string;
}

export interface CapabilityToken {
  claims: CapabilityTokenClaims;
  mac: string;
}

export interface CapabilityTokenRequest {
  capability: string;
  roots?: string[];
  maxRisk?: ActionRisk;
  actionIds?: string[];
  ttlMs?: number;
}

export interface AuthorityDecision {
  canonicalAction: ActionRequest;
  canonicalRisk: ActionRisk;
  capability: string;
}

type RiskResolver = (action: ActionRequest) => ActionRisk | Promise<ActionRisk>;

function capabilityAllowed(capability: string, allowed: readonly string[]): boolean {
  return allowed.some((rule) => rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1))));
}

function pathWithin(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function targetPath(action: ActionRequest, parentRoots: readonly string[]): string | undefined {
  const raw = typeof action.input.path === 'string'
    ? action.input.path
    : typeof action.input.cwd === 'string'
      ? action.input.cwd
      : undefined;
  if (!raw) return undefined;
  const syntax = normalizeScopedPathSyntax(raw);
  if (syntax.kind === 'native-absolute') return path.resolve(syntax.value);
  if (syntax.kind === 'foreign-windows-absolute' || parentRoots.length !== 1) return undefined;
  return path.resolve(parentRoots[0]!, syntax.value);
}

function tokenPayload(claims: CapabilityTokenClaims): string {
  return JSON.stringify({
    version: claims.version,
    tokenId: claims.tokenId,
    capability: claims.capability,
    roots: claims.roots,
    maxRisk: claims.maxRisk,
    actionIds: claims.actionIds,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt
  });
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Canonical authority boundary for one runtime process.
 *
 * Capability tokens are attenuating leases. They never replace PermissionProfile:
 * the normal policy/approval path runs first, and a token can only narrow the
 * already-authorized capability, roots, risk and optional action IDs.
 */
export class AuthorityKernel {
  readonly policy: PolicyEngine;
  #secret: Buffer;
  #clock: () => Date;

  constructor(options: { policy?: PolicyEngine; secret?: Buffer; clock?: () => Date } = {}) {
    this.policy = options.policy ?? new PolicyEngine();
    this.#secret = options.secret ? Buffer.from(options.secret) : crypto.randomBytes(32);
    if (this.#secret.length < 32) throw new PolicyError('AUTHORITY_SECRET_WEAK', 'Authority kernel secret must be at least 32 bytes.');
    this.#clock = options.clock ?? (() => new Date());
  }

  async authorize(
    action: ActionRequest,
    permissions: PermissionProfile,
    resolveDynamicRisk: RiskResolver,
    token?: CapabilityToken
  ): Promise<AuthorityDecision> {
    const decision = await this.authorizeRecovery(action, permissions, resolveDynamicRisk, token);
    this.policy.authorizeRisk(decision.canonicalAction, permissions);
    return decision;
  }

  /**
   * Non-dispatching recovery authority.
   *
   * Recovery may inspect durable provider/journal post-state after a crash even
   * when a one-shot mutation approval has already been consumed. It still
   * enforces provenance, capability/root scope, canonical risk identity, and
   * any capability token. A fresh side effect must pass authorize() again.
   */
  async authorizeRecovery(
    action: ActionRequest,
    permissions: PermissionProfile,
    resolveDynamicRisk: RiskResolver,
    token?: CapabilityToken
  ): Promise<AuthorityDecision> {
    this.policy.authorizeBase(action, permissions);
    const rule = capabilityRiskRule(action.capability);
    const canonicalRisk = rule === 'dynamic' ? await resolveDynamicRisk(action) : rule;
    assertCanonicalRisk(action, canonicalRisk);
    const canonicalAction = { ...action, risk: canonicalRisk };
    if (token) this.verifyToken(token, canonicalAction, permissions);
    return { canonicalAction, canonicalRisk, capability: action.capability };
  }

  issueToken(permissions: PermissionProfile, request: CapabilityTokenRequest): CapabilityToken {
    if (!capabilityAllowed(request.capability, permissions.allowedCapabilities)) {
      throw new PolicyError('AUTHORITY_CAPABILITY_ESCALATION', `Capability ${request.capability} is outside the parent authority.`);
    }

    const ttlMs = request.ttlMs ?? 5 * 60_000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) {
      throw new PolicyError('AUTHORITY_TTL_INVALID', 'Capability token TTL must be between 1 second and 1 hour.');
    }

    const roots = [...new Set((request.roots ?? permissions.allowedRoots).map((root) => path.resolve(root)))].sort();
    if (permissions.allowedRoots.length > 0) {
      for (const root of roots) {
        if (!permissions.allowedRoots.some((parent) => pathWithin(root, parent))) {
          throw new PolicyError('AUTHORITY_SCOPE_ESCALATION', 'Capability token root is outside the parent authority.', { root });
        }
      }
    }

    const actionIds = [...new Set(request.actionIds ?? [])].sort();
    if (actionIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 512)) {
      throw new PolicyError('AUTHORITY_ACTION_ID_INVALID', 'Capability token action IDs are invalid.');
    }

    const parentMaxRisk = permissions.maxRisk ?? 'destructive';
    const requestedMaxRisk = request.maxRisk ?? parentMaxRisk;
    if (RISK_ORDER[requestedMaxRisk] > RISK_ORDER[parentMaxRisk]) {
      throw new PolicyError('AUTHORITY_RISK_ESCALATION', 'Capability token risk ceiling exceeds the parent authority.', {
        parentMaxRisk,
        requestedMaxRisk
      });
    }

    const now = this.#clock();
    const claims: CapabilityTokenClaims = {
      version: 1,
      tokenId: crypto.randomUUID(),
      capability: request.capability,
      roots,
      maxRisk: requestedMaxRisk,
      actionIds,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString()
    };
    return { claims, mac: this.#sign(claims) };
  }

  verifyToken(token: CapabilityToken, action: ActionRequest, permissions: PermissionProfile): void {
    if (!token || token.claims?.version !== 1 || typeof token.mac !== 'string') {
      throw new PolicyError('AUTHORITY_TOKEN_INVALID', 'Capability token is invalid.');
    }
    const expected = this.#sign(token.claims);
    if (!safeEqualHex(token.mac, expected)) throw new PolicyError('AUTHORITY_TOKEN_TAMPERED', 'Capability token integrity check failed.');

    const now = this.#clock().getTime();
    const issuedAt = Date.parse(token.claims.issuedAt);
    const expiresAt = Date.parse(token.claims.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 30_000 || expiresAt <= now) {
      throw new PolicyError('AUTHORITY_TOKEN_EXPIRED', 'Capability token is expired or not yet valid.');
    }

    if (token.claims.capability !== action.capability) {
      throw new PolicyError('AUTHORITY_TOKEN_CAPABILITY_MISMATCH', 'Capability token does not authorize this capability.');
    }
    if (!capabilityAllowed(action.capability, permissions.allowedCapabilities)) {
      throw new PolicyError('AUTHORITY_CAPABILITY_ESCALATION', 'Capability token cannot exceed current parent authority.');
    }
    if (RISK_ORDER[action.risk] > RISK_ORDER[token.claims.maxRisk]) {
      throw new PolicyError('AUTHORITY_TOKEN_RISK_EXCEEDED', 'Capability token risk ceiling would be exceeded.');
    }
    if (token.claims.actionIds.length > 0 && !token.claims.actionIds.includes(action.id)) {
      throw new PolicyError('AUTHORITY_TOKEN_ACTION_MISMATCH', 'Capability token is bound to a different action.');
    }

    const candidate = targetPath(action, permissions.allowedRoots);
    if (token.claims.roots.length > 0) {
      if (!candidate || !token.claims.roots.some((root) => pathWithin(candidate, root))) {
        throw new PolicyError('AUTHORITY_TOKEN_SCOPE_MISMATCH', 'Capability token does not authorize this resource scope.');
      }
    }
  }

  #sign(claims: CapabilityTokenClaims): string {
    return crypto.createHmac('sha256', this.#secret).update(tokenPayload(claims)).digest('hex');
  }
}
