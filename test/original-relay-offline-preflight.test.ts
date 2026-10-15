import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assessOriginalRelayRecovery } from '../scripts/inspect-original-relay-recovery.mjs';

const fingerprint = 'a'.repeat(64);
const actionHash = 'b'.repeat(64);
async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-offline-relay-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = {
    'relay-client.json': { version: 1, lastAckedServerSeq: 3442 },
    'action-executions.json': { version: 1, records: [
      { actionId: 'mcp-write-01', risk: 'write', status: 'processing',
        actionHash, authorityHash: fingerprint },
      { actionId: 'mcp-read-02', risk: 'read', status: 'processing',
        actionHash, authorityHash: fingerprint },
      { actionId: 'mcp-terminal-03', risk: 'write', status: 'completed',
        actionHash, authorityHash: fingerprint }
    ] },
    'action-transitions.json': { version: 1, entries: [
      { actionId: 'mcp-write-01', generation: 1, state: 'PREPARED',
        transitions: [{ state: 'PREPARED' }] }
    ] }
  };
  for (const [name, value] of Object.entries(data)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(value));
  }
  return { dir, data };
}

test('original-host preflight does not turn PREPARED effects or read receipts into replay authority', async t => {
  const { dir } = await fixture(t);
  const before = new Map();
  for (const name of ['relay-client.json', 'action-executions.json', 'action-transitions.json']) {
    before.set(name, crypto.createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex'));
  }
  const result = await assessOriginalRelayRecovery(dir);
  assert.equal(result.kind, 'offline-original-host-relay-recovery-preflight');
  assert.equal(result.readOnly, true);
  assert.equal(result.hostDeliveryInspected, false);
  assert.equal(result.acknowledgedSequence, 3442);
  assert.equal(result.nextSequenceToInspect, 3443);
  assert.equal(result.processingReceipts, 2);
  assert.equal(result.receiptsTotal, 3);
  assert.equal(result.disposition, 'HOLD_ORIGINAL_AUTHORITY_AND_HOSTED_DELIVERY_PROOF');
  assert.equal(result.canReplayOrAcknowledge, false);
  assert.equal(result.pending.find(entry => entry.actionId === 'mcp-write-01')?.journalState, 'PREPARED');
  assert.equal(result.pending.find(entry => entry.actionId === 'mcp-read-02')?.journalState, 'ABSENT');
  assert.ok(result.pending.every(entry => entry.terminalEvidenceProven === false &&
    entry.originalEffectState === 'unknown' && entry.authorityBound && entry.actionBound));
  assert.equal(JSON.stringify(result).includes('mcp-terminal-03'), false,
    'terminal receipts are not exposed as pending work');
  for (const [name, expected] of before) {
    const after = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex');
    assert.equal(after, expected, 'read-only preflight must not modify ' + name);
  }
});

test('malformed or symlinked recovery input fails closed', async t => {
  const { dir } = await fixture(t);
  await fs.writeFile(path.join(dir, 'relay-client.json'), JSON.stringify({ version: 1, lastAckedServerSeq: -1 }));
  await assert.rejects(assessOriginalRelayRecovery(dir), /OFFLINE_PREFLIGHT_STATE_SCHEMA_INVALID/);
  await fs.writeFile(path.join(dir, 'relay-client.json'), JSON.stringify({ version: 1, lastAckedServerSeq: 3442 }));
  const link = path.join(dir, 'shadow');
  try {
    await fs.symlink(dir, link, 'junction');
    await assert.rejects(assessOriginalRelayRecovery(link), /OFFLINE_PREFLIGHT_ROOT_INVALID/);
  } catch (error: any) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) t.diagnostic('symlink creation unavailable on this runner');
    else throw error;
  }
});

test('output bounds untrusted values and does not disclose action input or credential data', async t => {
  const { dir } = await fixture(t);
  const actionFile = path.join(dir, 'action-executions.json');
  const data = JSON.parse(await fs.readFile(actionFile, 'utf8'));
  data.records[0].actionId = 'untrusted\ncredential:do-not-display';
  data.records[0].input = { token: 'SENSITIVE_NEVER_EXPOSE' };
  await fs.writeFile(actionFile, JSON.stringify(data));
  const report = await assessOriginalRelayRecovery(dir);
  assert.equal(report.pending.find(entry => entry.risk === 'write')?.actionId, 'INVALID');
  assert.equal(JSON.stringify(report).includes('SENSITIVE_NEVER_EXPOSE'), false);
  assert.equal(JSON.stringify(report).includes('credential:do-not-display'), false);
});
