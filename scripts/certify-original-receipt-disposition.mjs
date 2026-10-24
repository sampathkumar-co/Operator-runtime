/**
 * Read-only verification and inventory of original-device historical receipt
 * quarantine. No dispatch, result submission, ACK, state repair or deletions.
 *
 * Emits only hashed action IDs, bounded status, signed-ledger proof and file
 * digests; never emits action inputs, private identity, tokens or receipt owners.
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../src/core/action-identity.ts';

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const fail = (code) => { throw new Error(code); };
const caps = Object.freeze({
  'action-executions.json': 16 * 1024 * 1024,
  'action-transitions.json': 8 * 1024 * 1024,
  'operator-pre-dispatch-adjudications.json': 256 * 1024,
  'device-identity.json': 256 * 1024,
  'relay-client.json': 64 * 1024
});
async function stableRead(root, name) {
  const p = path.join(root, name);
  const st = await fs.lstat(p);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 2 || st.size > caps[name]) fail('BOUNDED_REGULAR_STATE_REQUIRED:' + name);
  const bytes = await fs.readFile(p);
  if (bytes.length !== st.size) fail('SOURCE_CONCURRENT_CHANGE:' + name);
  const obj = JSON.parse(bytes.toString('utf8'));
  return { obj, digest: sha(bytes), size: bytes.length };
}
function assertHex(v) { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v); }
function recordProofs(rootRecords) {
  const identity = rootRecords['device-identity.json'].obj;
  const pem = identity.publicKeyPem;
  if (identity.version !== 2 || typeof pem !== 'string' || !pem.includes('BEGIN PUBLIC KEY')) fail('PUBLIC_DEVICE_IDENTITY_INVALID');
  const deviceId = identity.deviceId;
  const fingerprint = crypto.createHash('sha256').update(pem).digest('base64url');
  const ledger = rootRecords['operator-pre-dispatch-adjudications.json'].obj;
  if (ledger.version !== 1 || !Array.isArray(ledger.decisions) || ledger.decisions.length > 256) fail('LEDGER_SCHEMA_INVALID');
  let previous = '0'.repeat(64);
  const byAction = new Map();
  for (const [index, decision] of ledger.decisions.entries()) {
    const { signature, ...unsigned } = decision;
    if (decision.version !== 1 || decision.epoch !== index + 1 ||
      decision.previousDigest !== previous || decision.deviceId !== deviceId ||
      decision.deviceFingerprint !== fingerprint || !assertHex(decision.actionDigest) ||
      !assertHex(decision.receiptAuthorityHash) || !assertHex(decision.caseDigest) ||
      !assertHex(decision.transitionsDigest) || decision.journalGeneration !== 1 ||
      decision.operatorAttestation !== 'I-CONFIRM-ORIGINAL-OWNER-STOPPED-AND-STATE-NOT-COPIED' ||
      typeof decision.actionId !== 'string' || !decision.receiptOwnerId ||
      typeof signature !== 'string' || byAction.has(decision.actionId)) fail('SIGNED_LEDGER_CHAIN_INVALID');
    if (!crypto.verify(null, Buffer.from(canonicalJson(unsigned)), pem, Buffer.from(signature, 'base64url'))) {
      fail('DEVICE_SIGNATURE_INVALID');
    }
    previous = sha(canonicalJson(decision));
    byAction.set(decision.actionId, decision);
  }
  return { decisions: byAction, deviceId, fingerprint, latestDigest: previous };
}
export async function certifyOriginalReceipts(dir = path.join(os.homedir(), '.operator')) {
  const root = path.resolve(dir);
  const st = await fs.lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('ORIGINAL_STATE_DIR_INVALID');
  const files = {};
  for (const name of Object.keys(caps)) files[name] = await stableRead(root, name);
  const proofs = recordProofs(files);
  const receiptDb = files['action-executions.json'].obj;
  const journalDb = files['action-transitions.json'].obj;
  const cursorDb = files['relay-client.json'].obj;
  if (receiptDb.version !== 1 || journalDb.version !== 1 || cursorDb.version !== 1 ||
    !Array.isArray(receiptDb.records) || !Array.isArray(journalDb.entries) ||
    !Number.isSafeInteger(cursorDb.lastAckedServerSeq)) fail('ORIGINAL_STATE_SCHEMA_INVALID');
  const entries = new Map();
  for (const j of journalDb.entries) {
    if (!j || typeof j.actionId !== 'string') continue;
    const previous = entries.get(j.actionId);
    if (!previous || j.generation > previous.generation) entries.set(j.actionId, j);
  }
  const outcomes = [];
  for (const record of receiptDb.records) {
    if (record.status !== 'processing') continue;
    const j = entries.get(record.actionId);
    const decision = proofs.decisions.get(record.actionId);
    let disposition;
    if (j?.state === 'INTERRUPTED' && j?.transitions?.at(-1)?.state === 'INTERRUPTED' && decision &&
      decision.actionDigest === record.actionHash && j.actionDigest === record.actionHash &&
      decision.receiptAuthorityHash === record.authorityHash &&
      decision.receiptOwnerId === record.ownerId &&
      decision.journalGeneration === j.generation && j.risk === record.risk) {
      disposition = 'SIGNED_TERMINAL_NO_REPLAY_RETAIN_RECEIPT';
    } else if (!j && !decision && record.risk === 'read') {
      disposition = 'READ_ONLY_RECEIPT_NO_JOURNAL_RETAIN_UNRESOLVED';
    } else {
      disposition = 'UNPROVEN_HOLD_NO_REPLAY';
    }
    outcomes.push({
      actionIdSha256: sha(record.actionId),
      risk: record.risk,
      journalState: j?.state ?? 'ABSENT',
      signedEpoch: decision?.epoch ?? null,
      disposition
    });
  }
  // Fail closed even on a second concurrent mutation while collecting metadata.
  for (const [name, original] of Object.entries(files)) {
    if ((await stableRead(root, name)).digest !== original.digest) fail('SOURCE_CHANGED_DURING_AUDIT:' + name);
  }
  outcomes.sort((a, b) => a.actionIdSha256.localeCompare(b.actionIdSha256));
  const summary = {};
  for (const r of outcomes) summary[r.disposition] = (summary[r.disposition] ?? 0) + 1;
  const unsupported = summary.UNPROVEN_HOLD_NO_REPLAY ?? 0;
  return {
    reportVersion: 1, kind: 'original-device-receipt-disposition-evidence',
    readOnly: true, effectStateProven: false, rawActionInputsIncluded: false,
    protectedStateModified: false, canDeleteReceipts: false, canReplayMutations: false,
    deviceId: proofs.deviceId, verifiedLedgerDecisions: proofs.decisions.size,
    signedChainHeadSha256: proofs.latestDigest,
    lastAckedServerSeq: cursorDb.lastAckedServerSeq,
    processingReceipts: outcomes.length, summary, unsupported, outcomes,
    sourceSha256: Object.fromEntries(Object.entries(files).map(([name, v]) => [name, v.digest])),
    releaseDisposition: unsupported === 0 ? 'FORMAL_QUARANTINE_INVENTORY_COMPLETE_HISTORICAL_RECEIPTS_RETAINED'
       : 'HOLD_EVIDENCE_INCOMPLETE'
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !path.isAbsolute(args[0]))) fail('USAGE_STATE_DIR_OPTIONAL');
  const out = await certifyOriginalReceipts(args[0]);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (out.unsupported > 0) process.exitCode = 2;
}
