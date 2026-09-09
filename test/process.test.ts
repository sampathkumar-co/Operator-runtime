import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';

function request(executable: string, args: string[], cwd: string) {
  return {
    id: crypto.randomUUID(), capability: 'terminal.execute', risk: 'write' as const,
    input: { executable, args, cwd, timeoutMs: 5000 }, provenance: { kind: 'chatgpt' as const }
  };
}

test('process provider uses allowlisted argv execution', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('node', ['-e', 'process.stdout.write("ok")'], root));
  assert.equal(result.ok, true);
  assert.equal((result.output as { stdout: string }).stdout, 'ok');
});

test('non-allowlisted executable is denied', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const result = await provider.execute(request('git', ['status'], root));
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'EXECUTABLE_DENIED');
});
