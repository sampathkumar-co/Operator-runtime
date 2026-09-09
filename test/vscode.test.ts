import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VsCodeProvider } from '../src/capabilities/vscode.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeFakeCode(t: test.TestContext): Promise<{ executable: string; prefix: string[]; logPath: string }> {
  const dir = await tempDir(t, 'operator-fake-code-');
  const script = path.join(dir, 'fake-code.cjs');
  const logPath = path.join(dir, 'calls.ndjson');
  await fs.writeFile(script, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  vscodeIpc: process.env.VSCODE_IPC_HOOK_CLI ?? null,
  vscodeCwd: process.env.VSCODE_CWD ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
}) + '\\n');
if (args.includes('--version')) {
  process.stdout.write('1.106.0\\ncommit\\nx64\\n');
  process.exit(0);
}
if (args.includes('--list-extensions')) {
  process.stdout.write('ms-vscode.test@1.2.3\\nesbenp.prettier-vscode@11.0.0\\n');
  process.exit(0);
}
if (args.includes('--status')) {
  process.stdout.write('Version: 1.106.0\\nProcess Memory: bounded\\n');
  process.exit(0);
}
process.stdout.write('accepted\\n');
process.exit(0);
`);
  return { executable: process.execPath, prefix: [script], logPath };
}

async function calls(logPath: string): Promise<Array<{ args: string[]; vscodeIpc: string | null; vscodeCwd: string | null; electronRunAsNode: string | null }>> {
  try {
    return (await fs.readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

test('VS Code inspection parses bounded CLI output and scrubs inherited VS Code IPC environment', async (t) => {
  const root = await tempDir(t, 'operator-vscode-project-');
  const authority = await tempDir(t, 'operator-vscode-authority-');
  const fake = await makeFakeCode(t);
  const provider = new VsCodeProvider({
    allowedRoots: [root],
    codeExecutable: fake.executable,
    codeArgsPrefix: fake.prefix,
    dataDir: path.join(authority, 'vscode-data')
  });
  const oldIpc = process.env.VSCODE_IPC_HOOK_CLI;
  const oldCwd = process.env.VSCODE_CWD;
  const oldElectron = process.env.ELECTRON_RUN_AS_NODE;
  process.env.VSCODE_IPC_HOOK_CLI = 'poisoned-ipc';
  process.env.VSCODE_CWD = 'poisoned-cwd';
  process.env.ELECTRON_RUN_AS_NODE = '1';
  t.after(() => {
    if (oldIpc === undefined) delete process.env.VSCODE_IPC_HOOK_CLI; else process.env.VSCODE_IPC_HOOK_CLI = oldIpc;
    if (oldCwd === undefined) delete process.env.VSCODE_CWD; else process.env.VSCODE_CWD = oldCwd;
    if (oldElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = oldElectron;
  });

  const result = await provider.execute({
    id: 'extensions', capability: 'vscode.inspect', risk: 'read', input: { operation: 'extensions' }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual((result.output as any).extensions, [
    { id: 'ms-vscode.test', version: '1.2.3' },
    { id: 'esbenp.prettier-vscode', version: '11.0.0' }
  ]);
  const recorded = await calls(fake.logPath);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].vscodeIpc, null);
  assert.equal(recorded[0].vscodeCwd, null);
  assert.equal(recorded[0].electronRunAsNode, null);
});

test('VS Code folder open always uses isolated new window with extensions disabled', async (t) => {
  const root = await tempDir(t, 'operator-vscode-open-');
  const authority = await tempDir(t, 'operator-vscode-open-authority-');
  const fake = await makeFakeCode(t);
  const dataDir = path.join(authority, 'safe-vscode');
  const provider = new VsCodeProvider({ allowedRoots: [root], codeExecutable: fake.executable, codeArgsPrefix: fake.prefix, dataDir });
  const result = await provider.execute({
    id: 'open-folder', capability: 'vscode.open', risk: 'system', input: { mode: 'folder', path: root }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal((result.output as any).isolated, true);
  assert.equal((result.output as any).extensionsDisabled, true);
  const recorded = await calls(fake.logPath);
  const args = recorded.at(-1)?.args ?? [];
  assert.ok(args.includes('--new-window'));
  assert.ok(args.includes('--disable-extensions'));
  assert.ok(args.includes(`--user-data-dir=${dataDir}`));
  assert.ok(args.includes(root));
  assert.equal(args.includes('--reuse-window'), false);
  await fs.access(dataDir);
});

test('VS Code goto and diff validate authorized existing files', async (t) => {
  const root = await tempDir(t, 'operator-vscode-files-');
  const authority = await tempDir(t, 'operator-vscode-files-authority-');
  const outside = await tempDir(t, 'operator-vscode-outside-');
  const fake = await makeFakeCode(t);
  const left = path.join(root, 'left.ts');
  const right = path.join(root, 'right.ts');
  const outsideFile = path.join(outside, 'outside.ts');
  await Promise.all([
    fs.writeFile(left, 'left\n'),
    fs.writeFile(right, 'right\n'),
    fs.writeFile(outsideFile, 'outside\n')
  ]);
  const provider = new VsCodeProvider({ allowedRoots: [root], codeExecutable: fake.executable, codeArgsPrefix: fake.prefix, dataDir: path.join(authority, 'safe') });

  const goto = await provider.execute({
    id: 'goto', capability: 'vscode.open', risk: 'system', input: { mode: 'goto', path: left, line: 7, column: 3 }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(goto.ok, true, goto.error?.message);
  let recorded = await calls(fake.logPath);
  assert.ok(recorded.at(-1)?.args.includes(`${left}:7:3`));

  const diff = await provider.execute({
    id: 'diff', capability: 'vscode.open', risk: 'system', input: { mode: 'diff', leftPath: left, rightPath: right }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(diff.ok, true, diff.error?.message);
  recorded = await calls(fake.logPath);
  const diffArgs = recorded.at(-1)?.args ?? [];
  assert.ok(diffArgs.includes('--diff'));
  assert.ok(diffArgs.includes(left));
  assert.ok(diffArgs.includes(right));

  const denied = await provider.execute({
    id: 'outside', capability: 'vscode.open', risk: 'system', input: { mode: 'file', path: outsideFile }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'PATH_OUTSIDE_SCOPE');
});

test('VS Code data directory inside project is denied before filesystem mutation or CLI launch', async (t) => {
  const root = await tempDir(t, 'operator-vscode-data-deny-');
  const fake = await makeFakeCode(t);
  const dataDir = path.join(root, '.operator-vscode', 'data');
  const provider = new VsCodeProvider({ allowedRoots: [root], codeExecutable: fake.executable, codeArgsPrefix: fake.prefix, dataDir });
  const result = await provider.execute({
    id: 'bad-data-dir', capability: 'vscode.inspect', risk: 'read', input: { operation: 'version' }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'VSCODE_DATA_DIR_INSIDE_PROJECT_DENIED');
  await assert.rejects(fs.access(path.join(root, '.operator-vscode')));
  assert.equal((await calls(fake.logPath)).length, 0);
});
