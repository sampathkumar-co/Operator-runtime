import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CENSUS_PATH = 'docs/c08-durable-writer-census.json';
export const SOURCE_ROOTS = Object.freeze(['src/core/', 'apps/local-agent/src/', 'apps/relay-server/src/']);
export const DURABLE_WRITE_MARKERS = Object.freeze([
  /\bwithDurableStateLock\s*\(/,
  /\batomicWriteJson\s*\(/,
  /#(?:serial|queue)\b/,
  /\b(?:fs\.)?(?:writeFile|appendFile|rename)\s*\(/
]);
const COORDINATION = new Set([
  'process-shared-lock', 'transactional-cas', 'append-only-chain',
  'exclusive-instance-lock', 'atomic-replace', 'external-owner'
]);
const TEST_PATH = /^(?:test\/[^/]+\.test\.ts|apps\/[^/]+\/test\/[^/]+\.test\.ts)$/;

const posix = value => String(value).replaceAll('\\', '/');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function scanDurableWriterCandidates(sourceFiles) {
  const found = [];
  for (const [rawPath, source] of Object.entries(sourceFiles)) {
    const file = posix(rawPath);
    if (!SOURCE_ROOTS.some(root => file.startsWith(root)) || !file.endsWith('.ts')) continue;
    if (typeof source !== 'string') throw new Error(`Source bytes are not text: ${file}`);
    if (DURABLE_WRITE_MARKERS.some(marker => marker.test(source))) found.push(file);
  }
  return [...new Set(found)].sort();
}

export function validateDurableWriterCensus({ sourceFiles, testFiles, census }) {
  if (!census || census.schemaVersion !== 1 || !Array.isArray(census.entries)) {
    throw new Error('C08 durable-writer census schema is invalid.');
  }
  if (census.scope?.protectedStateAccess !== 'PROHIBITED' || census.scope?.physicalAcceptance !== 'NOT_RUN') {
    throw new Error('C08 census must prohibit protected-state access and disclose physical acceptance as NOT_RUN.');
  }
  const candidates = scanDurableWriterCandidates(sourceFiles);
  const entries = new Map();
  for (const raw of census.entries) {
    const source = posix(raw?.source ?? '');
    if (!source || entries.has(source)) throw new Error(`Duplicate or invalid durable-writer census source: ${source || '<empty>'}`);
    if (!candidates.includes(source)) throw new Error(`Census entry is not a current durable-writer candidate: ${source}`);
    if (typeof raw.ownership !== 'string' || raw.ownership.trim().length < 12 || raw.ownership.length > 240) {
      throw new Error(`Durable-writer ownership classification is missing or unbounded: ${source}`);
    }
    if (!COORDINATION.has(raw.coordination)) throw new Error(`Durable-writer coordination is invalid: ${source}`);
    if (typeof raw.recoveryBoundary !== 'string' || raw.recoveryBoundary.trim().length < 12 || raw.recoveryBoundary.length > 280) {
      throw new Error(`Durable-writer recovery boundary is missing or unbounded: ${source}`);
    }
    if (!Array.isArray(raw.tests) || raw.tests.length === 0 || raw.tests.length > 8) {
      throw new Error(`Durable-writer test links are missing or unbounded: ${source}`);
    }
    const tests = raw.tests.map(posix);
    if (new Set(tests).size !== tests.length) throw new Error(`Durable-writer test links are duplicated: ${source}`);
    for (const test of tests) {
      if (!TEST_PATH.test(test) || !testFiles.has(test)) throw new Error(`Durable-writer linked test is missing or invalid: ${source} -> ${test}`);
    }
    entries.set(source, { ...raw, source, tests });
  }
  const missing = candidates.filter(file => !entries.has(file));
  if (missing.length) throw new Error(`Unclassified durable-writer candidates: ${missing.join(', ')}`);
  const listed = [...entries.keys()].sort();
  if (listed.length !== candidates.length) throw new Error('C08 durable-writer census does not exactly cover current candidates.');
  const canonical = JSON.stringify(listed.map(source => entries.get(source)));
  return {
    schemaVersion: 1,
    candidateCount: candidates.length,
    classifiedCount: listed.length,
    linkedTestCount: new Set([...entries.values()].flatMap(entry => entry.tests)).size,
    censusDigest: digest(canonical),
    protectedStateAccess: 'PROHIBITED',
    physicalAcceptance: 'NOT_RUN',
    releaseAcceptance: 'NOT_ACCEPTED'
  };
}

function gitFiles() {
  return execFileSync('git', ['ls-files', '-z'], { maxBuffer: 16 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean).map(posix);
}

export async function validateCurrentDurableWriterCensus() {
  const files = gitFiles();
  const sourcePaths = files.filter(file => SOURCE_ROOTS.some(root => file.startsWith(root)) && file.endsWith('.ts'));
  const testFiles = new Set(files.filter(file => TEST_PATH.test(file)));
  const sourceFiles = Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, await fs.readFile(file, 'utf8')])));
  const census = JSON.parse(await fs.readFile(CENSUS_PATH, 'utf8'));
  return validateDurableWriterCensus({ sourceFiles, testFiles, census });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(JSON.stringify(await validateCurrentDurableWriterCensus(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`C08 durable-writer source coverage failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
