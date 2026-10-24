import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/core/action-identity.ts';
import { certifyOriginalReceipts } from '../scripts/certify-original-receipt-disposition.mjs';

const h = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
const sample = (o: unknown) => JSON.stringify(o);

test('original receipt disposition verifies signed no-replay fence, preserves unjournaled read and rejects tampering without altering fixtures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-original-audit-test-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const id = crypto.randomUUID();
  const fingerprint = crypto.createHash('sha256').update(pem).digest('base64url');
  const writeId = 'mcp-fixture-mutating';
  const readId = 'mcp-fixture-reading';
  const actionHash = h('fixture-action');
  const authorityHash = h('fixture-authority');
  const ownerId = crypto.randomUUID();
  const decisionUnsigned = {
    version:1,epoch:1,actionId:writeId,actionDigest:actionHash,
    receiptAuthorityHash:authorityHash,receiptOwnerId:ownerId,
    caseDigest:h('fixture-case'),journalGeneration:1,
    transitionsDigest:h('fixture-transitions'),deviceId:id,deviceFingerprint:fingerprint,
    previousDigest:'0'.repeat(64),adjudicatedAt:'2026-10-24T03:00:00.000Z',
    operatorAttestation:'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED'
  };
  const decision = {
    ...decisionUnsigned,
    signature:crypto.sign(null, Buffer.from(canonicalJson(decisionUnsigned)),privateKey).toString('base64url')
  };
  const initial = {
    'device-identity.json': {version:2,deviceId:id,publicKeyPem:pem},
    'action-executions.json': {version:1,records:[
      {actionId:writeId,actionHash,authorityHash,ownerId,risk:'write',status:'processing'},
      {actionId:readId,actionHash:h('read-action'),authorityHash:h('read-authority'),ownerId:crypto.randomUUID(),risk:'read',status:'processing'}
    ]},
    'action-transitions.json': {version:1,entries:[{
      version:1,actionId:writeId,actionDigest:actionHash,generation:1,state:'INTERRUPTED',
      risk:'write',transitions:[{seq:1,state:'PREPARED'},{seq:2,state:'INTERRUPTED'}]
    }]},
    'operator-pre-dispatch-adjudications.json':{version:1,decisions:[decision]},
    'relay-client.json':{version:1,lastAckedServerSeq:3568}
  };
  for (const [n,v] of Object.entries(initial)) await fs.writeFile(path.join(root,n),sample(v));
  const snapshots = await Promise.all(Object.keys(initial).map(n=>fs.readFile(path.join(root,n))));
  const report=await certifyOriginalReceipts(root);
  assert.equal(report.processingReceipts,2);
  assert.equal(report.verifiedLedgerDecisions,1);
  assert.equal(report.summary.SIGNED_TERMINAL_NO_REPLAY_RETAIN_RECEIPT,1);
  assert.equal(report.summary.READ_ONLY_RECEIPT_NO_JOURNAL_RETAIN_UNRESOLVED,1);
  assert.equal(report.unsupported,0);
  assert.equal(report.canDeleteReceipts,false);
  assert.equal(report.canReplayMutations,false);
  assert.equal(JSON.stringify(report).includes(writeId),false);
  for (const [i,n] of Object.keys(initial).entries()) assert.deepEqual(await fs.readFile(path.join(root,n)),snapshots[i]);

  const tamper=structuredClone(initial['operator-pre-dispatch-adjudications.json']);
  tamper.decisions[0].signature='AAAA'+tamper.decisions[0].signature.slice(4);
  await fs.writeFile(path.join(root,'operator-pre-dispatch-adjudications.json'),sample(tamper));
  await assert.rejects(certifyOriginalReceipts(root),/DEVICE_SIGNATURE_INVALID/);
  await fs.writeFile(path.join(root,'operator-pre-dispatch-adjudications.json'),sample(initial['operator-pre-dispatch-adjudications.json']));
  const altered=structuredClone(initial['action-executions.json']);
  altered.records[0].authorityHash=h('wrong');
  await fs.writeFile(path.join(root,'action-executions.json'),sample(altered));
  const held=await certifyOriginalReceipts(root);
  assert.equal(held.unsupported,1);
  assert.equal(held.releaseDisposition,'HOLD_EVIDENCE_INCOMPLETE');
});
