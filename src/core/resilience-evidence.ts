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
  },
  {
    id: 'cross-action-resource-quarantine',
    invariant: 'PARALLEL_MUTATION_IS_COORDINATED',
    mechanism: 'Durable physical-resource quarantine across distinct action identities',
    implementationFile: 'src/core/agent-kernel.ts', implementationSymbol: 'await this.#leases.quarantine(entry.actionId',
    executableTestFile: 'test/agent-kernel-p0.test.ts', executableTestName: 'uncertain mutation quarantines the physical resource across action IDs until reconciliation',
    injectedFault: 'A mutation becomes uncertain and another action ID attempts to mutate the same physical resource.',
    expectedEvidence: 'The second action is blocked until the first action is reconciled.', status: 'EXECUTABLE'
  },
  {
    id: 'hierarchical-resource-conflict',
    invariant: 'PARALLEL_MUTATION_IS_COORDINATED',
    mechanism: 'Parent-child resource identities conflict under one canonical lease discipline',
    implementationFile: 'src/core/resource-leases.ts', implementationSymbol: 'resourceKeysConflict(item.key, key)',
    executableTestFile: 'test/agent-kernel-p0.test.ts', executableTestName: 'hierarchical resource leases reject parent-child mutation overlap',
    injectedFault: 'Concurrent mutations lease a parent resource and one of its descendants under different action IDs.',
    expectedEvidence: 'The descendant mutation is rejected while the parent lease remains active.', status: 'EXECUTABLE'
  },
  {
    id: 'unknown-process-liveness',
    invariant: 'PARALLEL_MUTATION_IS_COORDINATED',
    mechanism: 'Unknown process liveness preserves ownership instead of guessing that a lease is stale',
    implementationFile: 'src/core/resource-leases.ts', implementationSymbol: "if (observation.status === 'unknown') return true;",
    executableTestFile: 'test/resource-leases.test.ts', executableTestName: 'resource leases preserve a holder when process liveness is unknown',
    injectedFault: 'The runtime cannot determine whether the process holding a resource lease is still alive.',
    expectedEvidence: 'The lease is retained and a conflicting mutation cannot steal ownership.', status: 'EXECUTABLE'
  },
  {
    id: 'snapshot-crash-transaction',
    invariant: 'LONG_TASKS_SURVIVE_FAILURE',
    mechanism: 'Write-ahead multi-store snapshot restore with startup rollback recovery',
    implementationFile: 'src/core/state-snapshot.ts', implementationSymbol: 'recoverPendingSnapshotRestores',
    executableTestFile: 'test/state-snapshot.test.ts', executableTestName: 'startup recovery rolls back a hard-crashed multi-store restore to one coherent prior generation',
    injectedFault: 'The process hard-crashes after only part of a multi-store snapshot restore is durable.',
    expectedEvidence: 'Startup recovery restores every store to the same coherent prior generation.', status: 'EXECUTABLE'
  },
  {
    id: 'emergency-stop-mid-dispatch',
    invariant: 'BAD_WORKER_HAS_BOUNDED_BLAST_RADIUS',
    mechanism: 'Emergency-stop generation aborts already-dispatched provider work',
    implementationFile: 'apps/local-agent/src/server.ts', implementationSymbol: "emergencyExecutionGeneration.abort('EMERGENCY_STOPPED')",
    executableTestFile: 'test/emergency-stop-state-boundary-audit.test.ts', executableTestName: 'engaging emergency stop aborts an already-dispatched local provider request',
    injectedFault: 'Emergency stop is engaged after a local provider mutation has already been dispatched.',
    expectedEvidence: 'The in-flight provider receives the abort signal and the request fails closed.', status: 'EXECUTABLE'
  },
  {
    id: 'terminal-orphan-restart',
    invariant: 'LONG_TASKS_SURVIVE_FAILURE',
    mechanism: 'Exact process-instance orphan recovery with durable terminal tombstones',
    implementationFile: 'src/capabilities/process.ts', implementationSymbol: 'Exact owned orphan was quiesced during startup recovery.',
    executableTestFile: 'test/terminal-session-durability.test.ts', executableTestName: 'reconstruction recovers an exact surviving orphan and keeps truthful tombstone semantics',
    injectedFault: 'The owner restarts while an exact terminal-session child process survives as an orphan.',
    expectedEvidence: 'Only the exact owned orphan is quiesced and its durable tombstone remains truthful.', status: 'EXECUTABLE'
  },
  {
    id: 'receipt-partial-commit',
    invariant: 'MUTATIONS_ARE_IDEMPOTENT',
    mechanism: 'Completion-journal recovery repairs a receipt crash window without provider replay',
    implementationFile: 'src/core/action-transition-journal.ts', implementationSymbol: 'recoverPendingCompletion(',
    executableTestFile: 'test/local-action-execution-receipt.test.ts', executableTestName: 'restart repairs crash after kernel completion without replaying the provider mutation',
    injectedFault: 'The process crashes after kernel completion but before the local execution receipt is finalized.',
    expectedEvidence: 'Restart reconstructs the receipt from durable completion evidence without replaying the mutation.', status: 'EXECUTABLE'
  },
  {
    id: 'authority-generation-rotation',
    invariant: 'WORKER_CANNOT_EXPAND_AUTHORITY',
    mechanism: 'Relay delivery capability is bound to one monotonic authority generation',
    implementationFile: 'src/core/relay-client.ts', implementationSymbol: 'validateDeliveryCapabilityAuthority(frame, capabilityAuthority)',
    executableTestFile: 'test/relay-client.test.ts', executableTestName: 'authority generation change cannot inherit mutation authority from an old connection',
    injectedFault: 'A relay reconnect changes authority generation while an old delivery capability is retained.',
    expectedEvidence: 'The old capability cannot authorize mutation under the replacement connection.', status: 'EXECUTABLE'
  },
  {
    id: 'browser-any-target-conflict',
    invariant: 'PARALLEL_MUTATION_IS_COORDINATED',
    mechanism: 'Untargeted browser identity hierarchically covers every target in one browser instance',
    implementationFile: 'src/core/resource-identity.ts', implementationSymbol: 'if (!requestedTarget) return targets;',
    executableTestFile: 'test/resource-leases.test.ts', executableTestName: 'untargeted browser lease remains authoritative until target resolution',
    injectedFault: 'An untargeted browser mutation overlaps a concrete target mutation in the same browser instance.',
    expectedEvidence: 'The instance-wide lease blocks the concrete target until target resolution releases it.', status: 'EXECUTABLE'
  }
]);
