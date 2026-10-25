import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Source-only qualification. Passing this test says NOTHING about physical
// Chrome/Edge/UIA, OS session, UAC, database, Docker or released npm behavior.
const root = process.cwd();
const tracker = fs.readFileSync(path.join(root, 'docs/WAVE1_SOURCE_ACCEPTANCE_CENSUS_2026-10-25.md'), 'utf8');
const rows = [...tracker.matchAll(/^\| (C0[2346]-\d\d) \| `([^`]+)` \| `([^`]+)` \| ([^|]+) \|/gm)];
const expected = ['C02', 'C03', 'C04', 'C06'].flatMap(prefix =>
  Array.from({ length: ({ C02: 10, C03: 12, C04: 10, C06: 12 })[prefix] }, (_, i) =>
    prefix + '-' + String(i + 1).padStart(2, '0')));
const actual = rows.map(m => m[1]);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('WAVE1_CENSUS_INVALID: source census must enumerate the exact canonical 44 task IDs in order.');
}
for (const [, id, source, test, state] of rows) {
  if (![source, test].every(name =>
    name && !path.isAbsolute(name) && !name.includes('..') &&
    fs.statSync(path.join(root, name)).isFile())) {
    throw new Error('WAVE1_CENSUS_INVALID: missing local evidence source for ' + id);
  }
  if (id === 'C03-12' ? state.trim() !== 'SOURCE-GATE ACCEPTED'
    : state.trim() !== 'ACCEPTANCE OPEN') {
    throw new Error('WAVE1_CENSUS_INVALID: invented acceptance status for ' + id);
  }
}
if (!tracker.includes('Physical Windows acceptance: NOT_RUN') ||
    !tracker.includes('npm runtime remains 2.0.6')) {
  throw new Error('WAVE1_CENSUS_INVALID: mandatory source-only limitations missing.');
}
const suite = fs.readdirSync(path.join(root, 'test'))
  .filter(name => /^(?:c0[2346]-|browser-|windows-uia\.test\.ts$)/.test(name))
  .filter(name => name.endsWith('.test.ts'))
  .sort().map(name => path.join('test', name));
if (suite.length < 25) throw new Error('WAVE1_CENSUS_INVALID: insufficient test files discovered.');
process.stdout.write(JSON.stringify({
  type: 'WAVE1_SOURCE_ONLY',
  sourceCandidates: rows.length,
  acceptedSourceOnly: 1,
  openAcceptance: rows.length - 1,
  physicalAcceptance: 'NOT_RUN',
  includedTests: suite.length,
  paths: suite
}) + '\n');
const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=4', ...suite],
  { cwd: root, stdio: 'inherit', env: process.env, timeout: 15 * 60_000 });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
