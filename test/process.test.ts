import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessProvider } from '../src/capabilities/process.ts';
import type { ActionRisk } from '../src/core/types.ts';

function request(executable: string, args: string[], cwd: string, risk: ActionRisk = 'write') {
  return {
    id: crypto.randomUUID(), capability: 'terminal.execute', risk,
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

test('generic process provider can enforce destructive risk independently of caller input', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({
    allowedRoots: [root],
    allowedExecutables: ['node'],
    requiredRisk: 'destructive'
  });

  const underclassified = await provider.execute(request('node', ['-e', 'process.stdout.write("should-not-run")'], root, 'write'));
  assert.equal(underclassified.ok, false);
  assert.equal(underclassified.error?.code, 'PROCESS_RISK_MISMATCH');

  const approvedClass = await provider.execute(request('node', ['-e', 'process.stdout.write("ok")'], root, 'destructive'));
  assert.equal(approvedClass.ok, true);
  assert.equal((approvedClass.output as { stdout: string }).stdout, 'ok');
});

test('child process environment excludes ambient credentials and runtime injection variables', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const previous = {
    operator: process.env.OPERATOR_AGENT_TOKEN,
    aws: process.env.AWS_SECRET_ACCESS_KEY,
    nodeOptions: process.env.NODE_OPTIONS
  };
  process.env.OPERATOR_AGENT_TOKEN = 'operator-secret-that-must-not-cross-process-boundary';
  process.env.AWS_SECRET_ACCESS_KEY = 'ambient-cloud-secret-that-must-not-cross';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => {
    if (previous.operator === undefined) delete process.env.OPERATOR_AGENT_TOKEN; else process.env.OPERATOR_AGENT_TOKEN = previous.operator;
    if (previous.aws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = previous.aws;
    if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous.nodeOptions;
  });

  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });
  const script = [
    'process.stdout.write(JSON.stringify({',
    'operator: process.env.OPERATOR_AGENT_TOKEN ?? null,',
    'aws: process.env.AWS_SECRET_ACCESS_KEY ?? null,',
    'nodeOptions: process.env.NODE_OPTIONS ?? null,',
    'hasPath: Boolean(process.env.PATH || process.env.Path)',
    '}))'
  ].join('');
  const result = await provider.execute(request('node', ['-e', script], root));
  assert.equal(result.ok, true);
  const payload = JSON.parse((result.output as { stdout: string }).stdout) as Record<string, unknown>;
  assert.equal(payload.operator, null);
  assert.equal(payload.aws, null);
  assert.equal(payload.nodeOptions, null);
  assert.equal(payload.hasPath, true);
});

test('process arguments reject NUL and excessive entries before spawn', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provider = new ProcessProvider({ allowedRoots: [root], allowedExecutables: ['node'] });

  const nul = await provider.execute(request('node', ['bad\0arg'], root));
  assert.equal(nul.ok, false);
  assert.equal(nul.error?.code, 'PROCESS_INPUT_INVALID');

  const tooMany = await provider.execute(request('node', Array.from({ length: 201 }, () => 'x'), root));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error?.code, 'PROCESS_INPUT_INVALID');
});
