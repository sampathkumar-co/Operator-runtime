import { CAPABILITY_RISK_RULES } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, ProviderReconciliationResult } from './types.ts';
import { evidence } from './evidence.ts';

export type MutationReconciliationPolicy = {
  mode: 'provider' | 'side_effect_free';
  rationale: string;
};

export const MUTATION_RECONCILIATION_POLICIES = Object.freeze<Record<string, MutationReconciliationPolicy>>({
  'project.command.run': { mode: 'provider', rationale: 'Trusted commands can change declared project artifacts.' },
  'project.transaction.run': { mode: 'provider', rationale: 'Transactions can change both project files and command artifacts.' },
  'workspace.edit.transaction': { mode: 'provider', rationale: 'Workspace edit transactions reconcile through their durable transaction journal and exact file hashes.' },
  'workspace.edit.rollback': { mode: 'provider', rationale: 'Workspace edit rollback reconciles through its durable rollback journal and exact restored file hashes.' },
  'file.write': { mode: 'provider', rationale: 'Filesystem writes reconcile against the requested byte digest.' },
  'file.create': { mode: 'provider', rationale: 'Filesystem creates reconcile against existence and the requested byte digest.' },
  'file.replace': { mode: 'provider', rationale: 'Filesystem replacements reconcile against the requested byte digest.' },
  'file.manage': { mode: 'provider', rationale: 'Filesystem mutations reconcile against the requested path state.' },
  'git.checkpoint.create': { mode: 'provider', rationale: 'Checkpoint creation reconciles against the checkpoint reference.' },
  'git.checkpoint.restore': { mode: 'provider', rationale: 'Checkpoint restoration reconciles against repository state.' },
  'git.write': { mode: 'provider', rationale: 'Git writes reconcile from durable result and dispatch evidence.' },
  'docker.manage': { mode: 'provider', rationale: 'Docker mutations reconcile by inspecting current container state.' },
  'compute.run': { mode: 'side_effect_free', rationale: 'Compute uses an ephemeral --rm container with no network or host mounts; it cannot mutate user state.' },
  'vscode.open': { mode: 'provider', rationale: 'VS Code launch reconciles from durable result and dispatch evidence.' },
  'terminal.execute': { mode: 'provider', rationale: 'Process execution reconciles through its durable process record.' },
  'terminal.session': { mode: 'provider', rationale: 'Terminal sessions reconcile through their durable session record.' },
  'process.manage': { mode: 'provider', rationale: 'Process mutations reconcile through current process state.' },
  'browser.navigate': { mode: 'provider', rationale: 'Navigation reconciles against live tab state.' },
  'browser.interact': { mode: 'provider', rationale: 'Browser interaction reconciles against live semantic state.' },
  'browser.tab.focus': { mode: 'provider', rationale: 'Tab focus reconciles against the active target.' },
  'browser.tab.close': { mode: 'provider', rationale: 'Tab close reconciles against the live target set.' },
  'app.operate': { mode: 'provider', rationale: 'Native application operations reconcile from durable result and dispatch evidence.' },
  'input.operate': { mode: 'provider', rationale: 'Physical input reconciles from durable result and dispatch evidence.' },
  'perception.observe': { mode: 'provider', rationale: 'Perception publication reconciles from its durable graph result.' }
});

export function assertCanonicalMutationPolicies(): void {
  const expected = Object.entries(CAPABILITY_RISK_RULES)
    .filter(([, risk]) => risk !== 'read')
    .map(([capability]) => capability)
    .sort();
  const actual = Object.keys(MUTATION_RECONCILIATION_POLICIES).sort();
  if (expected.join('\n') !== actual.join('\n')) {
    throw new OperatorError('MUTATION_RECONCILIATION_POLICY_INCOMPLETE', 'Every canonical mutable capability must have exactly one reconciliation policy.', {
      details: {
        missing: expected.filter((capability) => !actual.includes(capability)),
        unexpected: actual.filter((capability) => !expected.includes(capability))
      }
    });
  }
}

export async function assertRegisteredMutationReconciliation(providers: readonly CapabilityProvider[]): Promise<void> {
  assertCanonicalMutationPolicies();
  for (const [capability, policy] of Object.entries(MUTATION_RECONCILIATION_POLICIES)) {
    const action: ActionRequest = {
      id: `reconciliation-coverage:${capability}`,
      capability,
      risk: CAPABILITY_RISK_RULES[capability] === 'dynamic' ? 'write' : CAPABILITY_RISK_RULES[capability]!,
      input: {},
      provenance: { kind: 'runtime' }
    };
    for (const provider of providers) {
      if (!await provider.supports(action)) continue;
      if (policy.mode === 'provider' && !provider.reconcile) {
        throw new OperatorError('PROVIDER_RECONCILIATION_CONTRACT_MISSING', `${provider.name} supports mutable capability ${capability} without a reconciliation contract.`, {
          details: { provider: provider.name, capability }
        });
      }
    }
  }
}

export function reconcileFromDurableResult(provider: string, capability: string, priorResult?: ActionResult): ProviderReconciliationResult {
  if (priorResult?.ok) {
    return {
      status: 'completed',
      result: priorResult,
      evidence: [evidence('reconciliation', 'pass', 'Durably recorded successful provider result proves completion.', { provider, capability })]
    };
  }
  if (priorResult?.error?.sideEffectState === 'none' || priorResult?.error?.executionPhase === 'pre_dispatch') {
    return {
      status: 'not_applied',
      evidence: [evidence('reconciliation', 'pass', 'Durable failure metadata proves the mutation was not dispatched or applied.', { provider, capability })]
    };
  }
  return {
    status: 'uncertain',
    evidence: [evidence('reconciliation', 'info', 'No durable observation proves whether the dispatched mutation completed.', { provider, capability })]
  };
}

assertCanonicalMutationPolicies();
