import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerProvider } from '../src/capabilities/docker.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

async function fakeDocker(t: test.TestContext, host: string): Promise<{ executable: string; prefix: string[]; logPath: string }> {
  const dir = await tempDir(t, 'operator-docker-npipe-fake-');
  const scriptPath = path.join(dir, 'fake-docker.cjs');
  const logPath = path.join(dir, 'calls.ndjson');
  await fs.writeFile(scriptPath, `
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'context' && argv[1] === 'show') { process.stdout.write('default\\n'); process.exit(0); }
if (argv[0] === 'context' && argv[1] === 'inspect') { process.stdout.write(${JSON.stringify(JSON.stringify(host) + '\n')}); process.exit(0); }
process.stderr.write('unexpected invocation');
process.exit(2);
`);
  return { executable: process.execPath, prefix: [scriptPath], logPath };
}

async function calls(logPath: string): Promise<string[][]> {
  try {
    return (await fs.readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

test('Docker adapter rejects remote Windows named-pipe contexts before daemon access', async (t) => {
  const root = await tempDir(t, 'operator-docker-npipe-root-');
  const fake = await fakeDocker(t, 'npipe:////remote-host/pipe/docker_engine');
  const provider = new DockerProvider({ allowedRoots: [root], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });

  const result = await provider.execute({
    id: 'remote-npipe',
    capability: 'docker.inspect',
    risk: 'read',
    input: { path: root },
    provenance: { kind: 'chatgpt' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'REMOTE_DOCKER_CONTEXT_DENIED');
  assert.equal((await calls(fake.logPath)).some((argv) => argv.includes('ps')), false);
});
