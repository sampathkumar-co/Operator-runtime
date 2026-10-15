import { actionHash } from '../../../src/core/action-identity.ts';
import type { ActionJournalEntry } from '../../../src/core/action-transition-journal.ts';
import type { ActionRequest } from '../../../src/core/types.ts';
import {
  localPidObservationAdmissible, processInstanceDefinitelyStale,
  type ProcessInstanceIdentity, type ProcessInstanceObservation
} from '../../../src/core/process-instance.ts';
import type { LocalActionExecutionRecord } from './action-execution-store.ts';

/**
 * Next-version recovery policy. Pure and fail-closed: it NEVER invokes a
 * provider, writes a receipt, advances a relay cursor, or grants an approval.
 * Only the journal's atomic interruptPreparedBeforeDispatch() can commit a
 * no-dispatch fence; this decision is just an eligibility preflight.
 */
export type RecoveryDisposition =
  | 'AUTOMATIC_PRE_DISPATCH_FENCE'
  | 'RECONCILE_TERMINAL_FENCE'
  | 'REVIEW_OR_PROVIDER_PROOF_REQUIRED'
  | 'AUTHORITY_CONFLICT_HOLD'
  | 'CURRENT_OWNER_RUNNING';

export interface RecoveryPolicyInput {
  action: ActionRequest;
  record: LocalActionExecutionRecord;
  journal: ActionJournalEntry;
  currentOwnerId: string;
  currentProcess: ProcessInstanceIdentity;
  originalOwnerObservation: ProcessInstanceObservation;
  /** Whether the original receipt authority was independently matched. */
  authorityMatches: boolean;
}

export function recoveryDisposition(input: RecoveryPolicyInput): RecoveryDisposition {
  const { action, record, journal, currentOwnerId, currentProcess, originalOwnerObservation } = input;
  if (!input.authorityMatches || record.actionId !== action.id ||
    record.actionHash !== actionHash(action) || journal.actionDigest !== actionHash(action) ||
    record.risk !== action.risk || journal.risk !== action.risk ||
    journal.actionId !== action.id || journal.capability !== action.capability) {
    return 'AUTHORITY_CONFLICT_HOLD';
  }
  if (record.status !== 'processing' || action.risk === 'read') {
    return 'REVIEW_OR_PROVIDER_PROOF_REQUIRED';
  }
  if (!record.ownerId || record.ownerId === currentOwnerId) return 'CURRENT_OWNER_RUNNING';
  // An INTERRUPTED journal is already fenced from any future dispatch. The
  // historical receipt can be repaired only for an exact terminal journal
  // lineage; no provider is run by this policy.
  const terminalFence = journal.generation === 1 && journal.state === 'INTERRUPTED' &&
    journal.transitions.length >= 2 &&
    journal.transitions[0]?.state === 'PREPARED' &&
    journal.transitions.at(-1)?.state === 'INTERRUPTED' &&
    journal.transitions.at(-1)?.provider === 'agent-kernel' &&
    journal.transitions.at(-1)?.resultDigest !== undefined &&
    (journal.transitions.length === 2 ||
      (journal.transitions.length === 3 && journal.transitions[1]?.state === 'DEFERRED' &&
        journal.transitions[1]?.provider === 'policy'));
  if (terminalFence) return 'RECONCILE_TERMINAL_FENCE';

  const originalPreDispatch = journal.generation === 1 &&
    journal.transitions[0]?.state === 'PREPARED' &&
    ((journal.state === 'PREPARED' && journal.transitions.length === 1) ||
      (journal.state === 'DEFERRED' && journal.transitions.length === 2 &&
        journal.transitions[1]?.state === 'DEFERRED' &&
        journal.transitions[1]?.provider === 'policy' &&
        typeof journal.transitions[1]?.resultDigest === 'string'));
  if (!originalPreDispatch || !record.ownerProcess) return 'REVIEW_OR_PROVIDER_PROOF_REQUIRED';
  // Host provenance MUST be a boot+PID-namespace-bound Linux v3 identity.
  // Windows FILETIME, macOS, copied/legacy identities, unknown observers,
  // and unbound process instances do NOT automatically prove a dead owner.
  const linuxV3 = /^linux-boot-id:[0-9a-f-]{36}:pidns:\d+:ticks:\d+$/;
  if (!linuxV3.test(record.ownerProcess.started) || !linuxV3.test(currentProcess.started) ||
    !localPidObservationAdmissible(record.ownerProcess, currentProcess) ||
    !processInstanceDefinitelyStale(record.ownerProcess, originalOwnerObservation)) {
    return 'REVIEW_OR_PROVIDER_PROOF_REQUIRED';
  }
  return 'AUTOMATIC_PRE_DISPATCH_FENCE';
}
