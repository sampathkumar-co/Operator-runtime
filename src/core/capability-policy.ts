import type { ActionRequest, ActionRisk } from './types.ts';
import { PolicyError } from './errors.ts';

export type CapabilityRiskRule = ActionRisk | 'dynamic';

export const CAPABILITY_RISK_RULES = Object.freeze<Record<string, CapabilityRiskRule>>({
  'computer.inspect': 'read',
  'project.inspect': 'read',
  'project.command.inspect': 'read',
  'project.command.run': 'dynamic',
  'project.transaction.run': 'destructive',
  'file.read': 'read',
  'file.list': 'read',
  'file.write': 'write',
  'file.create': 'write',
  'file.replace': 'destructive',
  'git.status': 'read',
  'git.diff': 'read',
  'git.rev-parse': 'read',
  'git.checkpoint.inspect': 'read',
  'git.checkpoint.create': 'write',
  'git.checkpoint.restore': 'destructive',
  'git.write': 'write',
  'docker.inspect': 'read',
  'docker.manage': 'system',
  'postgres.inspect': 'read',
  'postgres.select': 'read',
  'vscode.inspect': 'read',
  'vscode.open': 'system',
  'terminal.execute': 'destructive',
  'browser.inspect': 'read',
  'browser.navigate': 'write',
  'browser.interact': 'external',
  'browser.tab.focus': 'write',
  'browser.tab.close': 'destructive',
  'app.inspect': 'read',
  'app.operate': 'external'
});

export function capabilityRiskRule(capability: string): CapabilityRiskRule {
  const rule = CAPABILITY_RISK_RULES[capability];
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
