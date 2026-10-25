import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scanDurableWriterCandidates,
  validateCurrentDurableWriterCensus,
  validateDurableWriterCensus
} from '../scripts/c08-source-coverage.mjs';

const source = 'src/core/example-store.ts';
const linkedTest = 'test/example-store.test.ts';
const entry = Object.freeze({
  source,
  ownership: 'Independent runtime processes share this synthetic durable record.',
  coordination: 'process-shared-lock',
  recoveryBoundary: 'A restart retains the prior mutation identity and refuses an unproven replay.',
  tests: [linkedTest]
});
const fixture = (entries = [entry], overrides = {}) => ({
  sourceFiles: { [source]: 'await withDurableStateLock(file, async () => {});' },
  testFiles: new Set([linkedTest]),
  census: {
    schemaVersion: 1,
    scope: { protectedStateAccess: 'PROHIBITED', physicalAcceptance: 'NOT_RUN' },
    entries
  },
  ...overrides
});

test('C08 current source has exact machine-readable ownership and linked-test coverage', async () => {
  const result = await validateCurrentDurableWriterCensus();
  assert.equal(result.candidateCount, result.classifiedCount);
  assert.ok(result.candidateCount >= 57, 'coverage must not silently shrink below the reviewed baseline');
  assert.ok(result.linkedTestCount >= 90);
  assert.match(result.censusDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.protectedStateAccess, 'PROHIBITED');
  assert.equal(result.physicalAcceptance, 'NOT_RUN');
  assert.equal(result.releaseAcceptance, 'NOT_ACCEPTED');
});

test('C08 candidate discovery is deterministic, scoped, and separator independent', () => {
  const candidates = scanDurableWriterCandidates({
    'src/core/z.ts': 'await fs.writeFile(file, bytes);',
    'src/core/a.ts': 'private #queue: Promise<void> = Promise.resolve();',
    'apps\\local-agent\\src\\b.ts': 'await atomicWriteJson(file, value);',
    'apps/relay-server/src/c.ts': 'await fs.rename(staged, current);',
    'src/capabilities/not-in-scope.ts': 'await fs.writeFile(file, bytes);',
    'src/core/read-only.ts': 'return await fs.readFile(file);'
  });
  assert.deepEqual(candidates, [
    'apps/local-agent/src/b.ts', 'apps/relay-server/src/c.ts', 'src/core/a.ts', 'src/core/z.ts'
  ]);
});

test('C08 new or omitted durable writers fail closed instead of inheriting a generic claim', () => {
  assert.throws(() => validateDurableWriterCensus(fixture([])), /Unclassified durable-writer candidates: src\/core\/example-store\.ts/);
  const extra = {
    ...fixture(),
    sourceFiles: {
      [source]: 'await withDurableStateLock(file, async () => {});',
      'src/core/new-writer.ts': 'await fs.appendFile(file, bytes);'
    }
  };
  assert.throws(() => validateDurableWriterCensus(extra), /Unclassified durable-writer candidates: src\/core\/new-writer\.ts/);
});

test('C08 rejects stale classifications, missing tests, duplicates, and vague ownership', () => {
  assert.throws(() => validateDurableWriterCensus(fixture([{ ...entry, source: 'src/core/read-only.ts' }])),
    /not a current durable-writer candidate/);
  assert.throws(() => validateDurableWriterCensus(fixture([{ ...entry, tests: ['test/missing.test.ts'] }])),
    /linked test is missing or invalid/);
  assert.throws(() => validateDurableWriterCensus(fixture([entry, { ...entry }])),
    /Duplicate or invalid/);
  assert.throws(() => validateDurableWriterCensus(fixture([{ ...entry, ownership: 'shared' }])),
    /ownership classification is missing or unbounded/);
});

test('C08 evidence cannot claim physical acceptance or protected-state access', () => {
  assert.throws(() => validateDurableWriterCensus(fixture([entry], {
    census: { schemaVersion: 1, scope: { protectedStateAccess: 'READ_ONLY', physicalAcceptance: 'PASSED' }, entries: [entry] }
  })), /must prohibit protected-state access/);
});
