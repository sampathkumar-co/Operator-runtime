import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { ActionJournalEntry, ActionJournalState } from './action-transition-journal.ts';
import type { ActionRisk } from './types.ts';
import type { LocalActionExecutionRecord } from '../../apps/local-agent/src/action-execution-store.ts';

export type OriginalRecoveryStatus =
  | 'FENCED_AWAITING_RECONCILIATION'
  | 'REVIEW_REQUIRED'
  | 'OUTCOME_UNCERTAIN'
  | 'AUTHORITY_REVIEW_REQUIRED';

export interface OriginalRecoveryRow {
  /** Opaque, process-local display reference: NEVER the original action ID or an approval token. */
  actionId: string;
  capability: string;
  risk: ActionRisk;
  status: OriginalRecoveryStatus;
  explanation: string;
  journal: string;
  startedAt: string;
  /** Even terminal interruption does not constitute independent recovery proof. */
  ownerVerificationRequired: true;
  canApproveOnWebsite: false;
}

export interface OriginalRecoveryReviewModel {
  items: OriginalRecoveryRow[];
  counts: Record<OriginalRecoveryStatus, number>;
  websiteApprovalAvailable: false;
}

const STATES = new Set<ActionJournalState>([
  'PREPARED', 'DEFERRED', 'DISPATCHED', 'OBSERVED',
  'UNCERTAIN', 'RECONCILED', 'COMPLETED', 'INTERRUPTED'
]);
const RISKS = new Set<ActionRisk>(['read','write','external','system','destructive']);
const MAX_ROWS = 256;
const MAX_HISTORY = 64;
const SAFE_REFERENCE = /^[a-zA-Z0-9._:/-]{1,160}$/;
const REVIEW_REFERENCE_KEY = crypto.randomBytes(32);
function opaqueReviewReference(actionId: string): string {
  return 'review:' + crypto.createHmac('sha256', REVIEW_REFERENCE_KEY)
    .update('mecord.original-recovery.review.v1\0').update(actionId).digest('hex');
}

const SAFE_CAPABILITY = /^[a-z][a-z0-9._-]{0,127}$/;

/** Internal-only HMAC identity lookup. Original action IDs never reach the browser. */
export function locateOriginalRecoveryActionId(
  reference: unknown, receipts: readonly LocalActionExecutionRecord[]
): string | null {
  if (typeof reference !== 'string' || !/^review:[0-9a-f]{64}$/.test(reference) ||
      !Array.isArray(receipts) || receipts.length > MAX_ROWS) return null;
  const matches = receipts.filter(r => r && r.status === 'processing' &&
    typeof r.actionId === 'string' && SAFE_REFERENCE.test(r.actionId) &&
    opaqueReviewReference(r.actionId) === reference);
  return matches.length === 1 ? matches[0]!.actionId : null;
}

function invalid(): never {
  throw new OperatorError('ORIGINAL_RECOVERY_REVIEW_INVALID',
    'Recovery metadata is missing, oversized, duplicate or malformed; owner review remains blocked.');
}

/**
 * Source-only, read-only display projection. This is NOT an adjudication
 * decision, replay authority, signer or proof that an action did not run.
 * It never copies input, output, secrets, resource paths, owner identity,
 * process incarnation, authority hash, approval grants or raw journal objects.
 */
export function buildOriginalRecoveryReviewModel(
  receipts: readonly LocalActionExecutionRecord[],
  journalEntries: readonly ActionJournalEntry[]
): OriginalRecoveryReviewModel {
  if (!Array.isArray(receipts) || receipts.length > MAX_ROWS ||
      !Array.isArray(journalEntries) || journalEntries.length > 1000) invalid();
  const journals = new Map<string, ActionJournalEntry>();
  const duplicates = new Set<string>();
  for (const journal of journalEntries) {
    if (!journal || typeof journal.actionId !== 'string' ||
        !SAFE_REFERENCE.test(journal.actionId)) invalid();
    if (journals.has(journal.actionId)) duplicates.add(journal.actionId);
    else journals.set(journal.actionId, journal);
  }

  const seen = new Set<string>();
  const items: OriginalRecoveryRow[] = [];
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.actionId !== 'string' ||
        !SAFE_REFERENCE.test(receipt.actionId) ||
        !RISKS.has(receipt.risk) || typeof receipt.startedAt !== 'string' ||
        !Number.isFinite(Date.parse(receipt.startedAt))) invalid();
    if (receipt.status !== 'processing') continue;
    if (seen.has(receipt.actionId)) invalid();
    seen.add(receipt.actionId);

    const journal = journals.get(receipt.actionId);
    const history = journal && !duplicates.has(receipt.actionId) &&
      Array.isArray(journal.transitions) && journal.transitions.length >= 1 &&
      journal.transitions.length <= MAX_HISTORY &&
      journal.transitions.every(t => t && STATES.has(t.state))
      ? journal.transitions.map(t => t.state) : [];
    const match = Boolean(journal && history.length &&
      receipt.actionHash === journal.actionDigest &&
      receipt.risk === journal.risk && SAFE_CAPABILITY.test(journal.capability) &&
      history.at(-1) === journal.state);
    const undisbursedTerminal = Boolean(match && journal!.generation === 1 &&
      journal!.state === 'INTERRUPTED' &&
      history.length === 2 && history[0] === 'PREPARED' &&
      history[1] === 'INTERRUPTED');

    let status: OriginalRecoveryStatus;
    let explanation: string;
    if (receipt.risk === 'read' || !match) {
      status = 'AUTHORITY_REVIEW_REQUIRED';
      explanation = 'Journal and receipt authority need independent reconciliation before any action.';
    } else if (history.includes('DISPATCHED') || journal!.state === 'UNCERTAIN' ||
      journal!.state === 'OBSERVED' || journal!.state === 'RECONCILED' ||
      journal!.state === 'COMPLETED') {
      status = 'OUTCOME_UNCERTAIN';
      explanation = 'The provider may have run. Independently verify its effects before proceeding.';
    } else if (undisbursedTerminal) {
      status = 'FENCED_AWAITING_RECONCILIATION';
      explanation = 'Journal reports an interruption without dispatch. That report is not recovery approval.';
    } else {
      status = 'REVIEW_REQUIRED';
      explanation = 'The historical action is unresolved. Do not retry or infer owner consent.';
    }
    items.push({
      actionId: opaqueReviewReference(receipt.actionId),
      capability: match ? journal!.capability : 'Unverified action',
      risk: receipt.risk,
      status, explanation,
      journal: match ? history.join(' → ') : 'History unavailable or mismatched',
      startedAt: new Date(Date.parse(receipt.startedAt)).toISOString(),
      ownerVerificationRequired: true,
      canApproveOnWebsite: false
    });
  }
  const counts: Record<OriginalRecoveryStatus, number> = {
    FENCED_AWAITING_RECONCILIATION: 0,
    REVIEW_REQUIRED: 0,
    OUTCOME_UNCERTAIN: 0,
    AUTHORITY_REVIEW_REQUIRED: 0
  };
  for (const item of items) counts[item.status]++;
  return { items, counts, websiteApprovalAvailable: false };
}
