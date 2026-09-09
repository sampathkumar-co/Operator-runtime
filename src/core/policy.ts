import path from 'node:path';
import type { ActionRequest, PermissionProfile } from './types.ts';
import { PolicyError } from './errors.ts';
import { assertInstructionAuthority } from './provenance.ts';

function capabilityAllowed(capability: string, allowed: string[]): boolean {
  return allowed.some((rule) => rule === capability || (rule.endsWith('.*') && capability.startsWith(rule.slice(0, -1))));
}

function pathWithin(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PolicyEngine {
  authorize(action: ActionRequest, permissions: PermissionProfile): void {
    assertInstructionAuthority(action.provenance);

    if (!capabilityAllowed(action.capability, permissions.allowedCapabilities)) {
      throw new PolicyError('CAPABILITY_DENIED', `Capability ${action.capability} is not permitted.`);
    }

    const targetPath = typeof action.input.path === 'string'
      ? action.input.path
      : typeof action.input.cwd === 'string'
        ? action.input.cwd
        : undefined;

    if (targetPath && permissions.allowedRoots.length > 0) {
      if (!permissions.allowedRoots.some((root) => pathWithin(targetPath, root))) {
        throw new PolicyError('PATH_OUTSIDE_SCOPE', 'Requested path is outside the authorized roots.', { targetPath });
      }
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
}
