// Deliberately narrow live recovery for an original Windows device.
// Never copies protected .operator, executes fresh actions, or accepts a second relay delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeviceIdentityStore, WindowsDpapiProtector } from '../src/core/device-identity.ts';
import { RelayResultStore } from '../src/core/relay-result-store.ts';
import { RelayClient } from '../src/core/relay-client.ts';
import { acquireLocalAgentStateInstanceLock } from '../apps/local-agent/src/state-instance-lock.ts';
import { RelayEnrollmentClient } from '../apps/local-agent/src/relay-enrollment.ts';
import { RelaySessionCredentialManager, deriveRelaySessionRotateUrl } from '../apps/local-agent/src/relay-session-credentials.ts';

const RELAY_WS = 'wss://operator.splcart.in/device';
const RESULT_HTTPS = 'https://operator.splcart.in/v1/device-result';
const EXPECTED_PREVIOUS_SEQ = 3134;
const EXPECTED_SEQ = 3135;
const MAX_RUNTIME_MS = 60_000;
const fail = (code) => { throw new Error(code); };

if (process.platform !== 'win32' ||
    process.env.OPERATOR_RECOVER_3135_ONLY !== 'I_CONFIRM_ORIGINAL_DEVICE_AND_NO_ACTIVE_OWNER' ||
    !process.env.OPERATOR_RECOVERY_ORIGINAL_HOSTNAME ||
    os.hostname().toLowerCase() !== process.env.OPERATOR_RECOVERY_ORIGINAL_HOSTNAME.toLowerCase()) {
  fail('RECOVERY_ORIGINAL_DEVICE_ATTESTATION_REQUIRED');
}
const dpapiHelper = process.env.OPERATOR_WINDOWS_DPAPI_PATH;
if (!dpapiHelper || !path.win32.isAbsolute(dpapiHelper) ||
    !(await fs.stat(dpapiHelper).catch(() => null))?.isFile()) {
  fail('RECOVERY_VERIFIED_DPAPI_HELPER_REQUIRED');
}
const stateDir = path.join(os.homedir(), '.operator'); // original user's machine, never a copy
const stat = await fs.lstat(stateDir);
if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RECOVERY_PROTECTED_STATE_PATH_INVALID');
const originalState = JSON.parse(await fs.readFile(path.join(stateDir, 'relay-client.json'), 'utf8'));
if (originalState.version !== 1 || originalState.lastAckedServerSeq !== EXPECTED_PREVIOUS_SEQ ||
    originalState.processing !== undefined) {
  fail('RECOVERY_CURSOR_NOT_AT_ORIGINAL_3134');
}
const identity = new DeviceIdentityStore(stateDir, { dpapiExecutable: dpapiHelper });
const device = await identity.loadExisting();
if (!device) fail('RECOVERY_EXISTING_DEVICE_REQUIRED');
const outbox = new RelayResultStore(path.join(stateDir, 'relay-outbox'));
const saved = await outbox.get(device.deviceId, EXPECTED_SEQ);
if (!saved || !saved.result || saved.consumedAt || saved.seq !== EXPECTED_SEQ ||
    !/^[0-9a-f]{64}$/.test(saved.resultSha256)) {
  fail('RECOVERY_UNACKNOWLEDGED_3135_RECEIPT_REQUIRED');
}
const expectedId = saved.deliveryId;
const protectedStoreLock = await acquireLocalAgentStateInstanceLock(stateDir);
const protector = new WindowsDpapiProtector(dpapiHelper);
const enrollmentClient = new RelayEnrollmentClient({
  relayUrl: RELAY_WS, resultUrl: RESULT_HTTPS, identity
});
const enrollment = {
  recover: () => enrollmentClient.recover(),
  enroll: async () => fail('RECOVERY_NEW_PAIRING_FORBIDDEN'),
  stop: () => enrollmentClient.stop()
};
const credential = new RelaySessionCredentialManager({
  stateDir, legacyTokenFile: path.join(stateDir, 'relay-session.token'),
  rotateUrl: deriveRelaySessionRotateUrl(RELAY_WS, RESULT_HTTPS),
  protector, enrollment
});
let accepted = false;
let acknowledged = false;
let attemptedDelivery = false;
let client;
let timedOut = false;
let timeout;
try {
  client = new RelayClient({
    stateDir, url: RELAY_WS, identity,
    getSessionToken: () => credential.forConnection(),
    supportedCapabilities: [], // recovery-only session cannot claim ability to execute new tasks
    maxConcurrentReadDeliveries: 1,
    singleDeliveryRecovery: {
      previousSeq: EXPECTED_PREVIOUS_SEQ, seq: EXPECTED_SEQ, deliveryId: expectedId
    },
    onDelivery: async (delivery) => {
      if (attemptedDelivery) fail('RECOVERY_SECOND_ATTEMPT_REFUSED');
      attemptedDelivery = true;
      if (delivery.seq !== EXPECTED_SEQ || delivery.id !== expectedId) fail('RECOVERY_DELIVERY_MISMATCH');
      const current = await outbox.get(device.deviceId, EXPECTED_SEQ);
      if (!current?.result || current.deliveryId !== expectedId ||
          current.resultSha256 !== saved.resultSha256) {
        fail('RECOVERY_ORIGINAL_DURABLE_RESULT_CHANGED');
      }
      const token = await credential.forRequest();
      const response = await fetch(RESULT_HTTPS, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ seq: EXPECTED_SEQ, deliveryId: expectedId, result: current.result }),
        signal: AbortSignal.timeout(15_000)
      });
      let reply;
      try { reply = await response.json(); } catch { fail('RECOVERY_HOSTED_RESULT_NONJSON'); }
      if (response.status !== 200 || reply?.ok !== true ||
          reply?.accepted?.deviceId !== device.deviceId ||
          reply?.accepted?.seq !== EXPECTED_SEQ ||
          reply?.accepted?.deliveryId !== expectedId ||
          reply?.accepted?.resultSha256 !== saved.resultSha256) {
        fail('RECOVERY_HOSTED_RESULT_RECEIPT_NOT_VERIFIED_' + response.status);
      }
      accepted = true;
    },
    onAcknowledged: async (delivery) => {
      if (!accepted || delivery.seq !== EXPECTED_SEQ || delivery.id !== expectedId) {
        fail('RECOVERY_ACK_WITHOUT_HOSTED_PROOF');
      }
      const cursor = await client.state();
      if (cursor.lastAckedServerSeq !== EXPECTED_SEQ || cursor.processing) {
        fail('RECOVERY_ACK_NOT_DURABLE');
      }
      const deleted = await outbox.removeExact(device.deviceId, EXPECTED_SEQ, expectedId);
      if (!deleted) fail('RECOVERY_EXACT_OUTBOX_NOT_REMOVED');
      acknowledged = true;
    },
    onConnectionState: status => {
      // Deliberately report only bounded status codes; never credentials or frame payload.
      if (status.state === 'DEGRADED' || status.state === 'REVOKED') {
        console.log('RECOVERY_LINK_STATUS=' + status.state + ':' + status.code);
      }
    }
  });
  timeout = setTimeout(() => { timedOut = true; client.stop(); }, MAX_RUNTIME_MS);
  await client.run();
  if (timedOut) fail('RECOVERY_AUTHENTICATED_EXACT_DELIVERY_TIMEOUT');
  const finalState = await client.state();
  if (!accepted || !acknowledged || finalState.lastAckedServerSeq !== EXPECTED_SEQ ||
      finalState.processing !== undefined || await outbox.get(device.deviceId, EXPECTED_SEQ)) {
    fail('RECOVERY_REMOTE_AND_LOCAL_PROOF_INCOMPLETE');
  }
  console.log('RECOVERY_3135_LIVE_HOSTED_AND_LOCAL_CONFIRMED=' +
    JSON.stringify({ seq: EXPECTED_SEQ, originalHost: os.hostname(), sourceMatched: true,
      hostedResultSha256Verified: true, localCursorDurable: true,
      originalOutboxReceiptRemoved: true, freshActionDispatches: 0 }));
} finally {
  if (timeout) clearTimeout(timeout);
  client?.stop();
  credential.stop();
  await protectedStoreLock.release();
}
