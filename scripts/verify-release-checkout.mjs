import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const sourceRoot = path.resolve(import.meta.dirname, '..');
const state = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'docs', 'release-state.json'), 'utf8'));
const expected = String(state?.production?.sourceCommit ?? '').trim();
const target = path.resolve(process.argv[2] ?? sourceRoot);

if (!/^[0-9a-f]{40}$/i.test(expected)) {
  throw new Error('docs/release-state.json production.sourceCommit must be a full Git SHA.');
}
if (!fs.existsSync(target)) {
  throw new Error(`Target checkout does not exist: ${target}`);
}

function git(...args) {
  return execFileSync('git', args, { cwd: target, encoding: 'utf8' }).trim();
}

const head = git('rev-parse', 'HEAD');
const status = git('status', '--porcelain');
const branch = git('branch', '--show-current') || '(detached)';

console.log(`release-state expected: ${expected}`);
console.log(`target checkout:         ${target}`);
console.log(`checkout HEAD:           ${head}`);
console.log(`checkout branch:         ${branch}`);
console.log(`checkout clean:          ${status === '' ? 'yes' : 'no'}`);

if (head !== expected) {
  console.error('FAIL: checkout HEAD does not match the recorded production source commit.');
  process.exitCode = 1;
}
if (status !== '') {
  console.error('FAIL: checkout has uncommitted changes.');
  process.exitCode = 1;
}
if (process.exitCode !== 1) console.log('Mecord release checkout verification: PASS');
