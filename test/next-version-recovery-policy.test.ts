import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHash } from '../src/core/action-identity.ts';
import { recoveryDisposition, type RecoveryPolicyInput } from '../apps/local-agent/src/recovery-decision.ts';
import type { ActionRequest } from '../src/core/types.ts';

const action: ActionRequest = {
  id: 'next-version-action', capability: 'browser.navigate', risk: 'write',
  input: { url: 'https://example.com' }, provenance: { kind: 'chatgpt' }
};
const osIdentity = (started: string, pid = 2331) => ({ started, pid });
const linux = 'linux-boot-id:9d958c0b-0123-4567-8910-abcd12345678:pidns:401:';

function fixture(): RecoveryPolicyInput {
  const hash = actionHash(action);
  return {
    action, currentOwnerId: 'new-process', authorityMatches: true,
    currentProcess: osIdentity(linux + 'ticks:5000', 4551),
    originalOwnerObservation: { status: 'dead' },
    record: {
      actionId: action.id, actionHash: hash, authorityHash: 'a'.repeat(64),
      ownerId: 'old-process', ownerProcess: osIdentity(linux + 'ticks:3000'),
      risk: action.risk, status: 'processing', startedAt: '2026-10-15T00:00:00.000Z'
    },
    journal: {
      version: 1, actionId: action.id, actionDigest: hash, ownerKind: 'agent', ownerId: 'owner',
      capability: action.capability, risk: action.risk, resourceKeys: [],
      generation: 1, state: 'PREPARED',
      createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
      transitions: [{ seq: 1, state: 'PREPARED', at: '2026-10-15T00:00:00.000Z' }]
    }
  };
}
test('vNext: exact Linux v3 dead original PREPARED is an automatic fence CANDIDATE', () => {
  assert.equal(recoveryDisposition(fixture()), 'AUTOMATIC_PRE_DISPATCH_FENCE');
});
test('vNext: original policy-only DEFERRED is also a candidate', () => {
  const x = fixture();
  x.journal.state = 'DEFERRED';
  x.journal.transitions.push({ seq: 2, state: 'DEFERRED', provider: 'policy', resultDigest: 'b'.repeat(64), at: x.journal.updatedAt });
  assert.equal(recoveryDisposition(x), 'AUTOMATIC_PRE_DISPATCH_FENCE');
});
test('vNext: Windows FILETIME cannot auto recover even with a dead PID', () => {
  const x = fixture();
  x.record.ownerProcess = osIdentity('windows-filetime:134364173961843977');
  x.currentProcess = osIdentity('windows-filetime:134364173961843988');
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
});
test('vNext: transplanted Linux boot or PID namespace cannot auto recover', () => {
  for (const started of [
    'linux-boot-id:8d958c0b-0123-4567-8910-abcd12345678:pidns:401:ticks:5000',
    linux.replace('pidns:401', 'pidns:402') + 'ticks:5000',
    'linux-boot-ticks:5000'
  ]) {
    const x = fixture(); x.currentProcess = osIdentity(started);
    assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
  }
});
test('vNext: unknown and live same process cannot auto recover', () => {
  const x = fixture(); x.originalOwnerObservation = { status: 'unknown' };
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
  x.originalOwnerObservation = { status: 'live', identity: x.record.ownerProcess };
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
});
test('vNext: any provider dispatch, even later PREPARED, requires review', () => {
  const x = fixture();
  x.journal.transitions.push({ seq: 2, state: 'DISPATCHED', at: x.journal.updatedAt, provider: 'browser' });
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
});
test('vNext: completed, read, current-owner and ownerless cases never get auto-fence', () => {
  const x = fixture(); x.record.ownerId = 'new-process';
  assert.equal(recoveryDisposition(x), 'CURRENT_OWNER_RUNNING');
  x.record.ownerId = 'old-process'; delete x.record.ownerProcess;
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
  x.record.status = 'completed';
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
});
test('vNext: an original exact kernel terminal fence can be reconciled without the provider', () => {
  const x = fixture();
  x.record.ownerProcess = osIdentity('windows-filetime:134364173961843977');
  x.currentProcess = osIdentity('windows-filetime:134364173961843988');
  x.journal.state = 'INTERRUPTED';
  x.journal.transitions.push({ seq: 2, state: 'INTERRUPTED', at: x.journal.updatedAt,
    provider: 'agent-kernel', resultDigest: 'c'.repeat(64) });
  assert.equal(recoveryDisposition(x), 'RECONCILE_TERMINAL_FENCE');
});
test('vNext: fake terminal fence and replayed prior dispatch are refused', () => {
  const x = fixture();
  x.journal.state = 'INTERRUPTED';
  x.journal.transitions.push({ seq: 2, state: 'DISPATCHED', at: x.journal.updatedAt, provider: 'external' });
  x.journal.transitions.push({ seq: 3, state: 'INTERRUPTED', at: x.journal.updatedAt,
    provider: 'agent-kernel', resultDigest: 'c'.repeat(64) });
  assert.equal(recoveryDisposition(x), 'REVIEW_OR_PROVIDER_PROOF_REQUIRED');
});
test('vNext: mismatched authority / action / capability always holds', () => {
  const x = fixture(); x.authorityMatches = false;
  assert.equal(recoveryDisposition(x), 'AUTHORITY_CONFLICT_HOLD');
  x.authorityMatches = true; x.journal.capability = 'file.delete';
  assert.equal(recoveryDisposition(x), 'AUTHORITY_CONFLICT_HOLD');
});
