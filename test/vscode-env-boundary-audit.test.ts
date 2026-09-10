import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VsCodeProvider } from '../src/capabilities/vscode.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('VS Code CLI child receives no Operator/cloud/runtime-injection secrets', async (t) => {
  const root = await tempDir(t, 'operator-vscode-env-root-');
  const state = await tempDir(t, 'operator-vscode-env-state-');
  const fakeDir = await tempDir(t, 'operator-vscode-env-fake-');
  const scriptPath = path.join(fakeDir, 'fake-code.cjs');
  await fs.writeFile(scriptPath, `
const values = [
  process.env.OPERATOR_AGENT_TOKEN,
  process.env.AWS_SECRET_ACCESS_KEY,
  process.env.NODE_OPTIONS
].map((value) => value ?? 'missing');
process.stdout.write(values.join('|') + '\\n');
`);

  const previous = {
    OPERATOR_AGENT_TOKEN: process.env.OPERATOR_AGENT_TOKEN,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    NODE_OPTIONS: process.env.NODE_OPTIONS
  };
  process.env.OPERATOR_AGENT_TOKEN = 'operator-super-secret';
  process.env.AWS_SECRET_ACCESS_KEY = 'cloud-super-secret';
  process.env.NODE_OPTIONS = '--definitely-invalid-operator-option';
  t.after(() => {
    restoreEnv('OPERATOR_AGENT_TOKEN', previous.OPERATOR_AGENT_TOKEN);
    restoreEnv('AWS_SECRET_ACCESS_KEY', previous.AWS_SECRET_ACCESS_KEY);
    restoreEnv('NODE_OPTIONS', previous.NODE_OPTIONS);
  });

  const provider = new VsCodeProvider({
    allowedRoots: [root],
    codeExecutable: process.execPath,
    codeArgsPrefix: [scriptPath],
    dataDir: path.join(state, 'vscode-safe')
  });
  const result = await provider.execute({
    id: 'vscode-env',
    capability: 'vscode.inspect',
    risk: 'read',
    input: { operation: 'version' },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, true, result.error?.message);
  assert.equal((result.output as { version: string }).version, 'missing|missing|missing');
});
