import type { ActionRequest, ActionRisk } from './types.ts';
import { PolicyError } from './errors.ts';

export type CapabilityRiskRule = ActionRisk | 'dynamic';

export const CAPABILITY_RISK_RULES = Object.freeze<Record<string, CapabilityRiskRule>>({
  'computer.inspect': 'read',
  'project.inspect': 'read',
  'project.command.inspect': 'read',
  'project.command.run': 'dynamic',
  'project.transaction.run': 'destructive',
  'workspace.edit.transaction': 'write',
  'workspace.edit.rollback': 'destructive',
  'workspace.edit.resolve_lsp': 'read',
  'file.read': 'read',
  'file.list': 'read',
  'file.write': 'write',
  'file.create': 'write',
  'file.replace': 'destructive',
  'file.info': 'read',
  'file.search': 'read',
  'file.manage': 'dynamic',
  'git.status': 'read',
  'git.diff': 'read',
  'git.rev-parse': 'read',
  'git.checkpoint.inspect': 'read',
  'git.checkpoint.create': 'write',
  'git.checkpoint.restore': 'destructive',
  'git.write': 'write',
  'docker.inspect': 'read',
  'docker.manage': 'system',
  'compute.run': 'write',
  'postgres.inspect': 'read',
  'postgres.select': 'read',
  'vscode.inspect': 'read',
  'vscode.open': 'system',
  'terminal.execute': 'destructive',
  'terminal.session': 'dynamic',
  'process.inspect': 'read',
  'process.manage': 'destructive',
  'browser.inspect': 'read',
  'browser.verify': 'read',
  'browser.navigate': 'write',
  'browser.interact': 'external',
  'browser.tab.focus': 'write',
  'browser.tab.close': 'destructive',
  'app.inspect': 'read',
  'app.operate': 'external',
  'visual.capture': 'read',
  'input.operate': 'external',
  'perception.observe': 'write',
  'perception.ground': 'read',
  'document.inspect': 'read',
  'document.extract': 'read',
  'document.render': 'read',
  'structured.inspect': 'read',
  'structured.extract': 'read',
  'structured.render': 'read'
});

interface ExtensionRiskRegistration {
  rule: CapabilityRiskRule;
  owner: string;
  leases: number;
}
const EXTENSION_CAPABILITY_RISK_RULES = new Map<string, ExtensionRiskRegistration>();

export function isBuiltInCapability(capability: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_RISK_RULES, capability);
}

export function registerExtensionCapabilityRisk(input: {
  capability: string;
  rule: CapabilityRiskRule;
  extensionId: string;
  owner: string;
}): () => void {
  const capability = String(input.capability ?? '');
  const extensionId = String(input.extensionId ?? '');
  const owner = String(input.owner ?? '');
  const expectedPrefix = `ext.${extensionId}.`;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(extensionId)) {
    throw new PolicyError('CAPABILITY_EXTENSION_NAMESPACE_INVALID', 'Extension id is invalid for risk registration.');
  }
  if (!capability.startsWith(expectedPrefix) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,255}$/.test(capability)) {
    throw new PolicyError('CAPABILITY_EXTENSION_NAMESPACE_INVALID', `Extension capability must be namespaced under ${expectedPrefix}.`);
  }
  if (isBuiltInCapability(capability)) {
    throw new PolicyError('CAPABILITY_EXTENSION_SHADOW_DENIED', 'Extension capability cannot shadow a built-in capability.');
  }
  if (!['read','write','external','system','destructive','dynamic'].includes(input.rule)) {
    throw new PolicyError('CAPABILITY_EXTENSION_RISK_INVALID', 'Extension capability risk rule is invalid.');
  }
  if (!/^[0-9a-f]{64}$/.test(owner)) {
    throw new PolicyError('CAPABILITY_EXTENSION_OWNER_INVALID', 'Extension risk owner must be a SHA-256 identity.');
  }
  const existing = EXTENSION_CAPABILITY_RISK_RULES.get(capability);
  if (existing && (existing.rule !== input.rule || existing.owner !== owner)) {
    throw new PolicyError('CAPABILITY_EXTENSION_RISK_CONFLICT', 'Extension capability risk policy is already owned by another package.');
  }
  if (existing) existing.leases += 1;
  else EXTENSION_CAPABILITY_RISK_RULES.set(capability, { rule: input.rule, owner, leases: 1 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = EXTENSION_CAPABILITY_RISK_RULES.get(capability);
    if (!current || current.owner !== owner) return;
    if (current.leases <= 1) EXTENSION_CAPABILITY_RISK_RULES.delete(capability);
    else current.leases -= 1;
  };
}

export function capabilityRiskRule(capability: string): CapabilityRiskRule {
  const rule = CAPABILITY_RISK_RULES[capability] ?? EXTENSION_CAPABILITY_RISK_RULES.get(capability)?.rule;
  if (!rule) {
    throw new PolicyError(
      'CAPABILITY_RISK_UNREGISTERED',
      `Capability ${capability} has no canonical risk policy.`
    );
  }
  return rule;
}

export function assertCanonicalRisk(action: ActionRequest, canonicalRisk: ActionRisk): void {
  if (action.risk === canonicalRisk) return;
  throw new PolicyError(
    'ACTION_RISK_MISMATCH',
    `Capability ${action.capability} must be authorized as ${canonicalRisk}.`,
    { suppliedRisk: action.risk, canonicalRisk }
  );
}
