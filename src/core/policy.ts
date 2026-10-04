import path from 'node:path';
import type { ActionRequest, ActionRisk, PermissionProfile } from './types.ts';
import { PolicyError } from './errors.ts';
import { assertInstructionAuthority } from './provenance.ts';
import { assertCanonicalRisk, capabilityRiskRule } from './capability-policy.ts';
import { normalizeScopedPathSyntax } from './scoped-path-syntax.ts';
import { resourcePathOperandsForAction } from './resource-identity.ts';

const RISK_ORDER: Record<ActionRisk, number> = { read: 0, write: 1, external: 2, system: 3, destructive: 4 };

function capabilityAllowed(capability: string, allowed: string[]): boolean {
  return allowed.some((rule) => rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1))));
}

function pathWithin(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function policyPath(inputPath: string, roots: string[]): string | undefined {
  const syntax = normalizeScopedPathSyntax(inputPath);
  if (syntax.kind === 'native-absolute') return syntax.value;
  if (syntax.kind === 'foreign-windows-absolute' || roots.length !== 1) return undefined;
  return path.resolve(roots[0]!, syntax.value);
}

export class PolicyEngine {
  authorizeBase(action: ActionRequest, permissions: PermissionProfile): void {
    assertInstructionAuthority(action.provenance);

    if (!capabilityAllowed(action.capability, permissions.allowedCapabilities)) {
      throw new PolicyError('CAPABILITY_DENIED', `Capability ${action.capability} is not permitted.`);
    }

    if (permissions.allowedRoots.length > 0) {
      for (const targetPath of resourcePathOperandsForAction(action)) {
        const candidate = policyPath(targetPath, permissions.allowedRoots);
        if (!candidate || !permissions.allowedRoots.some((root) => pathWithin(candidate, root))) {
          throw new PolicyError('PATH_OUTSIDE_SCOPE', 'Requested path operand is outside the authorized roots.', { targetPath });
        }
      }
    }

  }

  authorizeRisk(action: ActionRequest, permissions: PermissionProfile): void {
    if (permissions.maxRisk !== undefined && RISK_ORDER[action.risk] > RISK_ORDER[permissions.maxRisk]) {
      throw new PolicyError('RISK_CEILING_EXCEEDED', `Action risk ${action.risk} exceeds the permission ceiling ${permissions.maxRisk}.`, {
        actionId: action.id,
        actionRisk: action.risk,
        maxRisk: permissions.maxRisk
      });
    }
    const approved = new Set(permissions.approvedActionIds ?? []);
    if (action.risk === 'external' && !permissions.allowExternalWrites && !approved.has(action.id)) {
      throw new PolicyError('APPROVAL_REQUIRED', 'External write requires explicit approval.', { actionId: action.id });
    }
    if (action.risk === 'system' && !permissions.allowSystemChanges && !approved.has(action.id)) {
      throw new PolicyError('APPROVAL_REQUIRED', 'System change requires explicit approval.', { actionId: action.id });
    }
    if (action.risk === 'destructive' && !permissions.allowDestructive && !approved.has(action.id)) {
      throw new PolicyError('APPROVAL_REQUIRED', 'Destructive action requires explicit approval.', { actionId: action.id });
    }
  }

  authorize(action: ActionRequest, permissions: PermissionProfile): void {
    this.authorizeBase(action, permissions);
    const rule = capabilityRiskRule(action.capability);
    if (rule === 'dynamic') throw new PolicyError('CAPABILITY_RISK_UNRESOLVED', `Capability ${action.capability} requires trusted dynamic risk resolution.`);
    assertCanonicalRisk(action, rule);
    this.authorizeRisk(action, permissions);
  }
}
