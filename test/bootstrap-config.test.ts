import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BootstrapConfigStore, applyBootstrapEnvironment } from '../apps/local-agent/src/bootstrap-config.ts';
import type { DeviceSecretProtector } from '../src/core/device-identity.ts';

class TestProtector implements DeviceSecretProtector {
  readonly scheme = 'windows-dpapi-current-user' as const;
  async protect(input: Buffer): Promise<Buffer> {
    return Buffer.from(input).reverse();
  }
  async unprotect(input: Buffer): Promise<Buffer> {
    return Buffer.from(input).reverse();
  }
}

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('bootstrap setup protects secrets and is idempotent across root changes', async (t) => {
  const state = await tempDir(t, 'operator-bootstrap-state-');
  const rootA = await tempDir(t, 'operator-bootstrap-root-a-');
  const rootB = await tempDir(t, 'operator-bootstrap-root-b-');
  const store = new BootstrapConfigStore(state, new TestProtector());

  const first = await store.configure(rootA);
  const raw = await fs.readFile(path.join(state, 'bootstrap.json'), 'utf8');
  assert.equal(raw.includes(first.agentToken), false);
  assert.equal(raw.includes(first.recoveryToken), false);
  assert.deepEqual(first.allowedRoots, [await fs.realpath(rootA)]);
  assert.equal(first.agentHost, '127.0.0.1');
  assert.equal(first.mcpHost, '127.0.0.1');
  assert.notEqual(first.agentPort, first.mcpPort);

  const loaded = await store.load();
  assert.equal(loaded.agentToken, first.agentToken);
  assert.equal(loaded.recoveryToken, first.recoveryToken);
  assert.deepEqual(loaded.allowedRoots, first.allowedRoots);

  const second = await store.configure(rootB);
  assert.equal(second.agentToken, first.agentToken);
  assert.equal(second.recoveryToken, first.recoveryToken);
  assert.equal(second.configuredAt, first.configuredAt);
  assert.deepEqual(second.allowedRoots, [await fs.realpath(rootB)]);
});

test('bootstrap setup rejects a missing or non-directory authorized root', async (t) => {
  const state = await tempDir(t, 'operator-bootstrap-state-invalid-');
  const store = new BootstrapConfigStore(state, new TestProtector());
  const missing = path.join(state, 'missing');
  await assert.rejects(store.configure(missing), (error: any) => error?.code === 'BOOTSTRAP_ROOT_INVALID');
  const file = path.join(state, 'file.txt');
  await fs.writeFile(file, 'x');
  await assert.rejects(store.configure(file), (error: any) => error?.code === 'BOOTSTRAP_ROOT_INVALID');
});

test('bootstrap load rejects tampered non-loopback service authority', async (t) => {
  const state = await tempDir(t, 'operator-bootstrap-state-tamper-');
  const root = await tempDir(t, 'operator-bootstrap-root-tamper-');
  const store = new BootstrapConfigStore(state, new TestProtector());
  await store.configure(root);

  const file = path.join(state, 'bootstrap.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  parsed.agent.host = '0.0.0.0';
  await fs.writeFile(file, JSON.stringify(parsed, null, 2));
  await assert.rejects(store.load(), (error: any) => error?.code === 'UNSAFE_LOCAL_BIND_HOST');
});

test('protected bootstrap authority replaces ambient roots, tokens, and local endpoints', async (t) => {
  const state = await tempDir(t, 'operator-bootstrap-state-env-');
  const root = await tempDir(t, 'operator-bootstrap-root-env-');
  const config = await new BootstrapConfigStore(state, new TestProtector()).configure(root);
  const keys = ['OPERATOR_STATE_DIR','OPERATOR_ALLOWED_ROOTS','OPERATOR_AGENT_TOKEN','OPERATOR_RECOVERY_TOKEN','OPERATOR_AGENT_HOST','OPERATOR_AGENT_PORT','OPERATOR_AGENT_URL','OPERATOR_MCP_HOST','OPERATOR_MCP_PORT'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.OPERATOR_STATE_DIR = 'C:\\attacker';
    process.env.OPERATOR_ALLOWED_ROOTS = path.parse(root).root;
    process.env.OPERATOR_AGENT_TOKEN = 'x'.repeat(64);
    process.env.OPERATOR_RECOVERY_TOKEN = 'y'.repeat(64);
    process.env.OPERATOR_AGENT_HOST = '127.0.0.1';
    process.env.OPERATOR_AGENT_PORT = '48111';
    process.env.OPERATOR_AGENT_URL = 'http://127.0.0.1:48111';
    process.env.OPERATOR_MCP_HOST = '127.0.0.1';
    process.env.OPERATOR_MCP_PORT = '48112';
    applyBootstrapEnvironment(config);
    assert.equal(process.env.OPERATOR_STATE_DIR, config.stateDir);
    assert.equal(process.env.OPERATOR_ALLOWED_ROOTS, config.allowedRoots.join(path.delimiter));
    assert.equal(process.env.OPERATOR_AGENT_TOKEN, config.agentToken);
    assert.equal(process.env.OPERATOR_RECOVERY_TOKEN, config.recoveryToken);
    assert.equal(process.env.OPERATOR_AGENT_URL, 'http://127.0.0.1:47100');
    assert.equal(process.env.OPERATOR_MCP_PORT, '47200');
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
