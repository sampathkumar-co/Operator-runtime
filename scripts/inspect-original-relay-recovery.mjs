/**
 * Read-only original-host relay recovery assessment.
 *
 * This program does not connect to a relay, authenticate, read session tokens,
 * acquire an authority lease, acknowledge work, replay actions or write state.
 * It only describes what local metadata can prove and explicitly refuses to
 * promote PREPARED/processing into a terminal result.
 *
 * Usage:
 *   node scripts/inspect-original-relay-recovery.mjs
 *   node scripts/inspect-original-relay-recovery.mjs --state-dir <isolated-fixture>
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = Object.freeze({
  'relay-client.json': 64 * 1024,
  'action-executions.json': 16 * 1024 * 1024,
  'action-transitions.json': 8 * 1024 * 1024
});
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_ENUM = /^[A-Za-z0-9_-]{1,40}$/;

function fail(code) { throw new Error(code); }
function safeEnum(value) { return typeof value === 'string' && SAFE_ENUM.test(value) ? value : 'INVALID'; }
function safeId(value) { return typeof value === 'string' && ID.test(value) ? value : 'INVALID'; }

async function readRegularJson(stateDir, name) {
  const file = path.join(stateDir, name);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES[name]) {
    fail('OFFLINE_PREFLIGHT_SOURCE_NOT_REGULAR_OR_BOUNDED:' + name);
  }
  // Never read secret-bearing identity/credential/token files.
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function assessOriginalRelayRecovery(stateDir = path.join(os.homedir(), '.operator')) {
  const root = path.resolve(stateDir);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('OFFLINE_PREFLIGHT_ROOT_INVALID');
  const [cursor, receiptData, journalData] = await Promise.all([
    readRegularJson(root, 'relay-client.json'),
    readRegularJson(root, 'action-executions.json'),
    readRegularJson(root, 'action-transitions.json')
  ]);
  if (cursor?.version !== 1 ||
      !Number.isSafeInteger(cursor.lastAckedServerSeq) ||
      cursor.lastAckedServerSeq < 0 ||
      !Array.isArray(receiptData?.records) ||
      !Array.isArray(journalData?.entries)) fail('OFFLINE_PREFLIGHT_STATE_SCHEMA_INVALID');

  const journalById = new Map();
  for (const journal of journalData.entries) {
    const id = safeId(journal?.actionId);
    if (id === 'INVALID') continue;
    const previous = journalById.get(id);
    if (!previous || Number(journal.generation) > Number(previous.generation)) journalById.set(id, journal);
  }
  const pending = [];
  for (const receipt of receiptData.records) {
    if (receipt?.status !== 'processing') continue;
    const id = safeId(receipt.actionId);
    const journal = journalById.get(id);
    const risk = safeEnum(receipt.risk);
    const journalState = journal ? safeEnum(journal.state) : 'ABSENT';
    pending.push({
      actionId: id,
      risk,
      receiptStatus: 'processing',
      journalState,
      authorityBound: typeof receipt.authorityHash === 'string' && /^[0-9a-f]{64}$/i.test(receipt.authorityHash),
      actionBound: typeof receipt.actionHash === 'string' && /^[0-9a-f]{64}$/i.test(receipt.actionHash),
      terminalEvidenceProven: false,
      originalEffectState: 'unknown'
    });
  }
  pending.sort((a, b) => a.actionId.localeCompare(b.actionId));

  return {
    kind: 'offline-original-host-relay-recovery-preflight',
    readOnly: true,
    hostDeliveryInspected: false,
    originalEffectsReconciled: false,
    acknowledgedSequence: cursor.lastAckedServerSeq,
    nextSequenceToInspect: cursor.lastAckedServerSeq + 1,
    cursorHasProcessingDelivery: Boolean(cursor.processing),
    receiptsTotal: receiptData.records.length,
    processingReceipts: pending.length,
    pending,
    disposition: 'HOLD_ORIGINAL_AUTHORITY_AND_HOSTED_DELIVERY_PROOF',
    canReplayOrAcknowledge: false,
    reason: 'Local PREPARED or processing metadata is not evidence of completion/non-application; authenticated exact hosted delivery, original-authority and provider-backed adjudication remain required.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--state-dir' || !path.isAbsolute(args[1]))) {
    fail('Usage: node scripts/inspect-original-relay-recovery.mjs [--state-dir ABSOLUTE_PATH]');
  }
  const report = await assessOriginalRelayRecovery(args.length ? args[1] : undefined);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
