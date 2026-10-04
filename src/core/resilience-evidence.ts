import type { ResilienceInvariant } from './resilience-matrix.ts';

export interface ExecutableResilienceEvidence {
  id: string;
  invariant: ResilienceInvariant;
  mechanism: string;
  implementationFile: string;
  implementationSymbol: string;
  executableTestFile: string;
  executableTestName: string;
  injectedFault: string;
  expectedEvidence: string;
  status: 'EXECUTABLE';
}

/** Critical resilience claims bound to concrete implementation and fault tests.
 * The 1,000-case matrix remains the breadth model; these entries are its
 * executable representatives and must be run by certification.
 */
export const CRITICAL_RESILIENCE_EVIDENCE: readonly ExecutableResilienceEvidence[] = Object.freeze([
  {
    id: 'uncertain-effect-crash',
    invariant: 'UNCERTAIN_SIDE_EFFECTS_REQUIRE_RECONCILIATION',
    mechanism: 'Action journal reconciliation before mutation redispatch',
    implementationFile: 'src/core/agent-kernel.ts', implementationSymbol: 'this.#runtime.reconcile(',
    executableTestFile: 'test/agent-kernel-p0.test.ts', executableTestName: 'uncertain mutation is reconciled by provider and journal completes without replay',
    injectedFault: 'Provider applies a mutation but returns an uncertain result as if the response were lost.',
    expectedEvidence: 'Provider reconciliation runs and execution count remains one.', status: 'EXECUTABLE'
  },
  {
    id: 'stale-intent-predispatch',
    invariant: 'NEWEST_INTENT_WINS',
    mechanism: 'Immediate pre-dispatch intent revalidation',
    implementationFile: 'src/core/agent-kernel.ts', implementationSymbol: 'preDispatchIntentFailure',
    executableTestFile: 'test/agent-kernel-p0.test.ts', executableTestName: 'newest intent wins before provider dispatch',
    injectedFault: 'Intent generation changes after planning and before provider dispatch.',
    expectedEvidence: 'Dispatch count remains zero and stale execution is rejected.', status: 'EXECUTABLE'
  },
  {
    id: 'approval-replay',
    invariant: 'WORKER_CANNOT_EXPAND_AUTHORITY',
    mechanism: 'One-shot action- and authority-bound approval leases',
    implementationFile: 'apps/local-agent/src/approval-store.ts', implementationSymbol: 'async claim(',
    executableTestFile: 'test/approval-lifecycle.test.ts', executableTestName: 'one-time approval binds exact action, resumes once, and cannot be replayed',
    injectedFault: 'A consumed approval is replayed for another execution attempt.',
    expectedEvidence: 'A new approval identity is required and replay is denied.', status: 'EXECUTABLE'
  },
  {
    id: 'duplicate-delivery',
    invariant: 'MUTATIONS_ARE_IDEMPOTENT',
    mechanism: 'Durable relay result identity and idempotent duplicate acceptance',
    implementationFile: 'src/core/relay-result-store.ts', implementationSymbol: 'duplicate: true',
    executableTestFile: 'apps/relay-server/test/result-service.test.ts', executableTestName: 'stores duplicates idempotently',
    injectedFault: 'The same authenticated relay result is delivered twice.',
    expectedEvidence: 'Only the first result is committed and the duplicate is reported idempotently.', status: 'EXECUTABLE'
  },
  {
    id: 'process-restart',
    invariant: 'LONG_TASKS_SURVIVE_FAILURE',
    mechanism: 'Durable processing receipts survive runtime reconstruction',
    implementationFile: 'apps/local-agent/src/action-execution-store.ts', implementationSymbol: 'export class LocalActionExecutionStore',
    executableTestFile: 'test/action-execution-store.test.ts', executableTestName: 'processing action execution receipt survives restart and prevents blind duplicate execution',
    injectedFault: 'The process restarts with a mutation receipt still processing.',
    expectedEvidence: 'The restarted store preserves processing and refuses a blind duplicate.', status: 'EXECUTABLE'
  },
  {
    id: 'stale-resource-identity',
    invariant: 'PARALLEL_MUTATION_IS_COORDINATED',
    mechanism: 'Process-instance-aware hierarchical resource leases',
    implementationFile: 'src/core/resource-leases.ts', implementationSymbol: 'sameProcessInstance(',
    executableTestFile: 'test/resource-leases.test.ts', executableTestName: 'resource leases reap a stale holder when its PID identifies a newer process instance',
    injectedFault: 'A PID is reused while a stale resource lease record remains.',
    expectedEvidence: 'The old process instance is distinguished and its stale lease is reclaimed.', status: 'EXECUTABLE'
  },
  {
    id: 'verification-false-positive',
    invariant: 'COMPLETION_REQUIRES_INDEPENDENT_VERIFICATION',
    mechanism: 'Runtime-owned fresh aggregate verification probes',
    implementationFile: 'src/core/canonical-verification.ts', implementationSymbol: 'executeCanonicalVerification',
    executableTestFile: 'test/aggregate-verification.test.ts', executableTestName: 'Studio cannot turn caller-authored ok=true into aggregate verification',
    injectedFault: 'A caller reports ok=true while the freshly observed final machine state is wrong.',
    expectedEvidence: 'Canonical verification fails and the workflow cannot become VERIFIED.', status: 'EXECUTABLE'
  },
  {
    id: 'compensation-crash',
    invariant: 'LONG_TASKS_SURVIVE_FAILURE',
    mechanism: 'Durable compensation intent recovery',
    implementationFile: 'src/core/digital-operations.ts', implementationSymbol: 'recoverPendingCompensations',
    executableTestFile: 'test/digital-operations.test.ts', executableTestName: 'creation cleanup persists compensation failure and restart recovery completes it',
    injectedFault: 'Cleanup compensation fails and the coordinating process is reconstructed.',
    expectedEvidence: 'The durable compensation remains pending and restart recovery completes it.', status: 'EXECUTABLE'
  },
  {
    id: 'relay-partition',
    invariant: 'PROVIDER_LOSS_IS_RECOVERABLE',
    mechanism: 'Drain accepted destructive work before reconnecting transport',
    implementationFile: 'src/core/relay-client.ts', implementationSymbol: 'drainConnection(',
    executableTestFile: 'test/relay-client.test.ts', executableTestName: 'unexpected network loss drains an in-flight destructive delivery before reconnecting',
    injectedFault: 'The relay transport disappears while destructive delivery work is in flight.',
    expectedEvidence: 'No replacement connection opens until work reaches a durable boundary.', status: 'EXECUTABLE'
  }
]);
