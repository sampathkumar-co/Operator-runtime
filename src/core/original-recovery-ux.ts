import type { ActionJournalEntry } from './action-transition-journal.ts';
import type { ActionRisk } from './types.ts';
import type { LocalActionExecutionRecord } from '../../apps/local-agent/src/action-execution-store.ts';

/** Read-only UI projection. Never include payload, output, secret, authority hash, or signer material. */
export type OriginalRecoveryStatus =
  | 'FENCED_AWAITING_RECONCILIATION' | 'REVIEW_REQUIRED'
  | 'OUTCOME_UNCERTAIN' | 'AUTHORITY_REVIEW_REQUIRED';

export interface OriginalRecoveryRow {
  actionId: string;
  capability: string;
  risk: ActionRisk;
  status: OriginalRecoveryStatus;
  explanation: string;
  journal: string;
  startedAt: string;
  ownerVerificationRequired: boolean;
  /** Always false until a separately certified, authenticator-backed step-up exists. */
  canApproveOnWebsite: false;
}

export function buildOriginalRecoveryReviewModel(
  receipts: readonly LocalActionExecutionRecord[],
  journalEntries: readonly ActionJournalEntry[]
): { items: OriginalRecoveryRow[]; counts: Record<OriginalRecoveryStatus, number>; websiteApprovalAvailable: false } {
  const indexed = new Map<string, ActionJournalEntry | null>();
  const duplicates = new Set<string>();
  for (const entry of journalEntries) {
    if (indexed.has(entry.actionId)) duplicates.add(entry.actionId);
    else indexed.set(entry.actionId, entry);
  }
  const seen = new Set<string>();
  const items: OriginalRecoveryRow[] = [];
  for (const receipt of receipts) {
    if (receipt.status !== 'processing') continue;
    if (seen.has(receipt.actionId)) throw new Error('Duplicate recovery receipts; refuse ambiguous owner review.');
    seen.add(receipt.actionId);
    const journal = indexed.get(receipt.actionId);
    const matches = journal && !duplicates.has(receipt.actionId)
      && receipt.actionHash === journal.actionDigest && receipt.risk === journal.risk;
    const history = matches ? journal.transitions.map(x => x.state) : [];
    const terminal = matches && journal.state === 'INTERRUPTED' && journal.generation === 1
      && history.length >= 2 && history[0] === 'PREPARED'
      && history.at(-1) === 'INTERRUPTED' && !history.includes('DISPATCHED');
    let status: OriginalRecoveryStatus;
    let explanation: string;
    if (receipt.risk === 'read') {
      status = 'AUTHORITY_REVIEW_REQUIRED';
      explanation = 'Read result must not cross authority generations. Await authenticated reconciliation.';
    } else if (!matches) {
      status = 'AUTHORITY_REVIEW_REQUIRED';
      explanation = 'Receipt and execution journal do not form a uniquely matching history.';
    } else if (terminal) {
      status = 'FENCED_AWAITING_RECONCILIATION';
      explanation = 'Journal reports terminal interruption. Receipt repair still needs trusted verification.';
    } else if (history.includes('DISPATCHED') || journal.state === 'UNCERTAIN' ||
      journal.state === 'OBSERVED' || journal.state === 'RECONCILED') {
      status = 'OUTCOME_UNCERTAIN';
      explanation = 'A provider may have run. Verify the external effect before deciding next steps.';
    } else {
      status = 'REVIEW_REQUIRED';
      explanation = 'Historical action awaits independent owner review. No automatic retry is allowed.';
    }
    items.push({
      actionId: receipt.actionId,
      capability: matches ? journal.capability : 'Unverified action',
      risk: receipt.risk, status, explanation,
      journal: matches ? history.join(' → ') : 'History unavailable or mismatched',
      startedAt: receipt.startedAt,
      ownerVerificationRequired: status !== 'FENCED_AWAITING_RECONCILIATION',
      canApproveOnWebsite: false
    });
  }
  const counts: Record<OriginalRecoveryStatus, number> = {
    FENCED_AWAITING_RECONCILIATION: 0, REVIEW_REQUIRED: 0,
    OUTCOME_UNCERTAIN: 0, AUTHORITY_REVIEW_REQUIRED: 0
  };
  for (const item of items) counts[item.status]++;
  return { items, counts, websiteApprovalAvailable: false };
}
