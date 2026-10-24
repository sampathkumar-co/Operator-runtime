import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function requireState(x, message) {
  if (!x) throw new Error('WAVE0_JOURNEY_CATALOG_INVALID: ' + message);
}
export function validateJourneyCandidates(document) {
  requireState(document && typeof document === 'object' && !Array.isArray(document), 'document missing');
  requireState(document.schemaVersion === 1 && document.scenarioCount === 50 &&
    document.classification === 'PUBLIC_CANDIDATES_NOT_SEALED_HOLDOUT',
    'source-only candidate provenance absent');
  requireState(Array.isArray(document.domains) && document.domains.length === 10 &&
    new Set(document.domains).size === 10 && Array.isArray(document.journeys) &&
    document.journeys.length === 50, 'require 50 scenarios spanning 10 domains');
  const names = new Set();
  const counts = new Map();
  const goals = new Set();
  for (const [idx, caseFile] of document.journeys.entries()) {
    requireState(caseFile && typeof caseFile === 'object' && !Array.isArray(caseFile), 'invalid scenario');
    const expectedId = 'journey_' + String(idx + 1).padStart(3, '0');
    requireState(caseFile.id === expectedId && !names.has(caseFile.id), 'sequence or identity changed');
    names.add(caseFile.id);
    requireState(document.domains.includes(caseFile.domain), 'unregistered case domain');
    counts.set(caseFile.domain, (counts.get(caseFile.domain) ?? 0) + 1);
    requireState(typeof caseFile.goal === 'string' && caseFile.goal.length >= 24 &&
      caseFile.goal.length <= 250 && !goals.has(caseFile.goal), 'invalid or duplicated user goal');
    goals.add(caseFile.goal);
    requireState(typeof caseFile.oracle === 'string' && caseFile.oracle.length >= 24 &&
      caseFile.oracle.length <= 250, 'missing independently verifiable postcondition specification');
    requireState(caseFile.fixture === 'NOT_PROVISIONED' &&
      caseFile.state === 'SPEC_ONLY_NOT_EXECUTABLE' &&
      caseFile.independentScorer === 'NOT_IMPLEMENTED' &&
      caseFile.outcome === 'NOT_RUN', 'candidate case has unsupported success claim');
    requireState(caseFile.authority === 'DISPOSABLE_APPROVED_SCOPE_REQUIRED',
      'case would imply live account permission');
  }
  requireState(document.domains.every(d => counts.get(d) === 5), 'domain balance differs from frozen catalogue');
  requireState(document.physicalEnvironment === 'NOT_PROVISIONED' &&
    document.independentScorers === 'NOT_IMPLEMENTED' &&
    document.score === 'NOT_RUN' &&
    document.releaseAcceptance === 'NOT_ACCEPTED',
    'must not present public examples as independent empirical evaluation');
  const normalized = document.journeys.map(x => ({ id: x.id, domain: x.domain, goal: x.goal, oracle: x.oracle }));
  return {
    schemaVersion: 1, totalCandidateJourneys: 50, domainCount: 10,
    candidateDescriptionsSha256: hash(JSON.stringify(normalized)),
    executionStatus: 'NOT_RUN',
    independence: 'PUBLIC_NOT_SEALED_OR_HELD_OUT',
    fixtureStatus: 'NOT_PROVISIONED',
    scorerStatus: 'NOT_IMPLEMENTED',
    realUserOutcome: 'NOT_VERIFIED',
    releaseAcceptance: 'NOT_ACCEPTED'
  };
}
export async function currentJourneyCandidates() {
  const document = JSON.parse(await fs.readFile(new URL('../certification/wave0/realistic-journey-candidates-v1.json', import.meta.url), 'utf8'));
  return validateJourneyCandidates(document);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(JSON.stringify(await currentJourneyCandidates(), null, 2) + '\n');
}
