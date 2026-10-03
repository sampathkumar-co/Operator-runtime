import crypto from 'node:crypto';
import { actionHash, canonicalJson } from './action-identity.ts';
import type { ActionJournalEntry } from './action-transition-journal.ts';
import type { ActionRequest, ActionResult, Evidence } from './types.ts';
import { VerificationKernel, type VerificationReceipt } from './verification-kernel.ts';

export function verifyActionOutcome(input: {
  action: ActionRequest;
  result: ActionResult;
  journal?: ActionJournalEntry;
}): VerificationReceipt {
  const { action, result, journal } = input;
  const evidenceDigest = digest(result.evidence);
  const outputDigest = digest(result.output ?? null);
  const checks = [
    {
      name: 'action-succeeded',
      ok: result.ok,
      detail: result.ok ? 'Provider returned a successful action result.' : 'Provider did not return a successful action result.',
      evidenceDigests: [evidenceDigest]
    },
    {
      name: 'capability-bound',
      ok: result.capability === action.capability,
      detail: result.capability === action.capability
        ? 'Result capability matches the authorized action.'
        : 'Result capability does not match the authorized action.',
      evidenceDigests: [evidenceDigest]
    },
    {
      name: 'provider-evidence-present',
      ok: result.evidence.some((item) => item.status === 'pass'),
      detail: result.evidence.some((item) => item.status === 'pass')
        ? 'At least one provider-generated passing evidence item supports the outcome.'
        : 'No provider-generated passing evidence item supports the outcome.',
      evidenceDigests: [evidenceDigest]
    },
    {
      name: 'journal-identity',
      ok: !journal || (journal.actionDigest === actionHash(action)
        && journal.actionId === action.id
        && ['OBSERVED','RECONCILED','COMPLETED'].includes(journal.state)),
      detail: !journal
        ? 'No durable journal was supplied; verification is result/evidence bound only.'
        : 'Durable action journal identity and execution state match the action being verified.',
      evidenceDigests: [evidenceDigest]
    }
  ];

  return new VerificationKernel().verify({
    subjectKind: 'action-outcome',
    subjectId: action.id,
    contract: {
      version: 1,
      actionDigest: actionHash(action),
      capability: action.capability,
      risk: action.risk,
      provider: result.provider,
      outputDigest,
      evidenceDigest,
      journalState: journal?.state ?? null,
      intent: action.intent ?? null
    },
    checks
  });
}

export function kernelVerificationEvidence(receipt: VerificationReceipt): Evidence {
  return {
    kind: 'kernel_verification',
    status: receipt.verified ? 'pass' : 'fail',
    message: receipt.verified
      ? 'Agent Kernel independently bound this action result to its authorized action, provider evidence, and durable transition journal.'
      : 'Agent Kernel rejected this action result against its execution contract.',
    data: {
      verificationDigest: receipt.digest,
      contractDigest: receipt.contractDigest
    },
    timestamp: new Date().toISOString()
  };
}

export function kernelVerificationDigest(result: ActionResult): string | undefined {
  for (let index = result.evidence.length - 1; index >= 0; index -= 1) {
    const item = result.evidence[index];
    if (item?.kind !== 'kernel_verification' || item.status !== 'pass') continue;
    const value = item.data?.verificationDigest;
    if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  }
  return undefined;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
