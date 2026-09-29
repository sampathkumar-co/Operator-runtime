import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseBenchmarkRunnerArgs,
  validateBenchmarkBinding
} from '../apps/local-agent/src/benchmark-runner.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('registered benchmark runner accepts only the exact hash-bound Python and controller', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-benchmark-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const python = path.join(root, 'python.exe');
  const script = path.join(root, 'controller.py');
  await fs.writeFile(python, 'fake-python-binary');
  await fs.writeFile(script, 'print("ok")\n');

  const parsed = parseBenchmarkRunnerArgs([
    '--root', root,
    '--python', python,
    '--python-sha256', digest('fake-python-binary'),
    '--script', script,
    '--script-sha256', digest('print("ok")\n')
  ]);
  const binding = await validateBenchmarkBinding(parsed);
  assert.equal(binding.root, await fs.realpath(root));
  assert.equal(binding.python, await fs.realpath(python));
  assert.equal(binding.script, await fs.realpath(script));

  await fs.writeFile(script, 'print("changed")\n');
  await assert.rejects(
    validateBenchmarkBinding(parsed),
    /controller SHA-256 no longer matches/
  );
});

test('registered benchmark runner refuses a controller outside its benchmark root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-benchmark-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-benchmark-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const python = path.join(root, 'python.exe');
  const script = path.join(outside, 'controller.py');
  await fs.writeFile(python, 'fake-python-binary');
  await fs.writeFile(script, 'print("outside")\n');

  await assert.rejects(
    validateBenchmarkBinding({
      root,
      python,
      pythonSha256: digest('fake-python-binary'),
      script,
      scriptSha256: digest('print("outside")\n')
    }),
    /must remain inside the registered benchmark root/
  );
});

test('benchmark runner arguments reject missing, duplicate, and unknown fields', () => {
  assert.throws(() => parseBenchmarkRunnerArgs(['--root', 'x']), /incomplete/);
  assert.throws(() => parseBenchmarkRunnerArgs([
    '--root', 'x', '--root', 'y',
    '--python', 'z', '--python-sha256', 'a'.repeat(64),
    '--script', 's', '--script-sha256', 'b'.repeat(64)
  ]), /Duplicate/);
  assert.throws(() => parseBenchmarkRunnerArgs([
    '--root', 'x', '--python', 'z', '--python-sha256', 'a'.repeat(64),
    '--script', 's', '--unknown', 'b'.repeat(64)
  ]), /Invalid/);
});
