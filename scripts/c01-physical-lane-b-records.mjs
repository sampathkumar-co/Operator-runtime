import crypto from 'node:crypto';
import { buildWave0EvaluationReport } from './wave0-evaluation.mjs';

const SHA = /^[0-9a-f]{40}$/;
const hash = value => crypto.createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value)
).digest('hex');
function bad(message) { throw new Error('C01_LANE_B_RECEIPT_INVALID: ' + message); }

/**
 * Transform an observed fixed-action browser case into a *partial* Lane B
 * evaluation record. The physical campaign must independently inspect the
 * server ledger before calling this function. These caller-supplied records
 * cannot authenticate their own origin and do not certify release readiness.
 */
export function laneBPhysicalReceiptRecord({
  sourceCommit, ordinal, runNonce, runnerSha256, environmentSha256,
  expected, server, preState, observedPostState, latencyMs, rejectedSubmissions
}) {
  if (typeof sourceCommit !== 'string' || !SHA.test(sourceCommit) ||
      !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 4 ||
      typeof runNonce !== 'string' || !/^[a-f0-9]{24}$/.test(runNonce) ||
      !/^[a-f0-9]{64}$/.test(runnerSha256) ||
      !/^[a-f0-9]{64}$/.test(environmentSha256) ||
      !expected || !server || typeof expected !== 'object' || typeof server !== 'object' ||
      !Number.isFinite(latencyMs) || latencyMs < 0 ||
      !Number.isSafeInteger(rejectedSubmissions) || rejectedSubmissions !== 0) {
    bad('physical source, numeric counters or exact run identities missing');
  }
  for (const part of ['id', 'value', 'receipt']) {
    if (typeof expected[part] !== 'string' ||
        expected[part].length > 128 || expected[part].length < 1 ||
        expected[part] !== server[part]) bad('server receipt and requested ' + part + ' mismatch');
  }
  if (expected.id !== 'id-' + ordinal + '-' + runNonce || server.accepted !== true ||
      preState !== 'NOT_COMPLETE' || observedPostState !== 'VERIFIED') {
    bad('independent pre/post state or server oracle not satisfied');
  }
  return {
    id: 'lane_b_' + expected.id, lane: 'B', arm: 'mecord_scripted',
    sourceCommit, scenarioId: 'local_receipt_form_' + String(ordinal + 1).padStart(2, '0'),
    scenarioVersion: 'v1', seed: ordinal,
    model: 'scripted', provider: 'browser.cdp',
    claimedSuccess: true, verifiedSuccess: true,
    failureStage: 'none',
    runnerDigest: runnerSha256,
    modelConfigDigest: hash('model-independent-fixed-provider-script:v1'),
    environmentDigest: environmentSha256,
    independentOracleDigest: hash({caseId: expected.id, submittedValue: server.value,
      expectedReceipt: expected.receipt, accepted: server.accepted}),
    resultEvidenceDigest: hash({id: server.id, receipt: server.receipt,
      observedPostState, accepted: server.accepted}),
    latencyMs, costMicros: 0, humanInterventions: 0, unauthorizedEffects: 0
  };
}

export function partialLaneBPhysicalReport({sourceCommit, records}) {
  if (!Array.isArray(records) || records.length !== 5 ||
      records.some(record => record?.sourceCommit !== sourceCommit)) {
    bad('exact five source-matched fixed-action records required');
  }
  const report = buildWave0EvaluationReport({sourceCommit, records});
  if (report.lanes.B.status !== 'PARTIAL' ||
      report.lanes.B.evidence?.verifiedSuccesses !== 5 ||
      report.lanes.A.status !== 'NOT_RUN' || report.lanes.C.status !== 'NOT_RUN' ||
      report.releaseAcceptance !== 'NOT_ACCEPTED') {
    bad('partial Lane B coverage cannot be promoted into a full campaign');
  }
  return report;
}
