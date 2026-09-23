import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountDeviceRegistry } from '../../../src/core/account-device-registry.ts';
import { AuditLog } from '../../../src/core/audit.ts';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { DeviceRegistryStore, answerPairingChallenge } from '../../../src/core/device-registry.ts';
import { RelayDeliveryStore } from '../../../src/core/relay-delivery-store.ts';
import { DeviceSessionTokenStore } from '../../../src/core/session-token.ts';
import { createRuntime } from '../../local-agent/src/runtime-factory.ts';
import { LocalAgentRelayRunner } from '../../local-agent/src/relay-agent.ts';
import { createLocalAgentServer } from '../../local-agent/src/server.ts';
import { RelayHub } from '../src/relay-hub.ts';
import { RelayResultService } from '../src/result-service.ts';
import { supportedGitAvailable } from '../../../test/git-test-support.ts';

const gitTest = supportedGitAvailable() ? test : test.skip;

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not satisfied within ${timeoutMs} ms`);
}

async function pairDevice(authorityIdentity: DeviceIdentityStore, devices: DeviceRegistryStore, deviceIdentity: DeviceIdentityStore) {
  const authority = await authorityIdentity.loadOrCreate('Relay Authority');
  const device = await deviceIdentity.loadOrCreate('Operator Test PC');
  const challenge = await devices.issuePairingChallenge(authority, { expectedPeerDeviceId: device.deviceId, ttlMs: 60_000 });
  await devices.completePairing(await answerPairingChallenge(challenge, deviceIdentity));
  return device;
}

test('relay action executes through the real local policy boundary and returns a durable structured result', async (t) => {
  const authorityState = await tempDir(t, 'operator-action-authority-');
  const deviceState = await tempDir(t, 'operator-action-device-');
  const projectRoot = await tempDir(t, 'operator-action-root-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'local-agent-e2e' });
  await accounts.bindDevice(account.accountId, device.deviceId);

  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  const resultService = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, deliveries });
  t.after(() => Promise.allSettled([hub.close(), resultService.close()]));
  const hubBound = await hub.listen('127.0.0.1', 0);
  const resultBound = await resultService.listen('127.0.0.1', 0);

  const token = (await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'relay:result', 'cap:computer.inspect', 'cap:browser.interact'],
    ttlMs: 60_000
  })).token;
  const tokenFile = path.join(deviceState, 'relay-session.token');
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

  const agentToken = 'a'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [projectRoot], allowedExecutables: ['node'], browserAutoLaunch: false });
  const audit = new AuditLog(deviceState);
  const agent = createLocalAgentServer({
    runtime,
    token: agentToken,
    audit,
    permissions: {
      allowedCapabilities: ['computer.inspect', 'browser.interact'],
      allowedRoots: [projectRoot],
      allowExternalWrites: false,
      allowSystemChanges: false,
      allowDestructive: false
    }
  });
  const agentBound = await agent.listen('127.0.0.1', 0);
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));

  const runner = new LocalAgentRelayRunner({
    stateDir: deviceState,
    relayUrl: `ws://127.0.0.1:${hubBound.port}/device`,
    resultUrl: `http://127.0.0.1:${resultBound.port}/v1/device-result`,
    sessionTokenFile: tokenFile,
    identity: deviceIdentity,
    localAgentBaseUrl: `http://127.0.0.1:${agentBound.port}`,
    agentToken,
    supportedCapabilities: ['computer.inspect', 'browser.interact'],
    allowLoopbackInsecure: true
  });
  const run = runner.run();
  t.after(() => { runner.stop(); });
  await waitFor(async () => (await hub.onlineDevices(account.accountId)).some((entry) => entry.deviceId === device.deviceId));

  const inspect = await hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['computer.inspect'],
    kind: 'action',
    payload: { action: {
      id: 'relay-inspect-1',
      capability: 'computer.inspect',
      risk: 'read',
      input: {},
      provenance: { kind: 'chatgpt', source: 'relay-e2e' }
    } }
  });
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === inspect.delivery.seq);
  const inspectResult = await resultService.getResult(device.deviceId, inspect.delivery.seq);
  assert.equal((inspectResult?.result as any)?.ok, true);
  assert.equal((inspectResult?.result as any)?.capability, 'computer.inspect');

  const denied = await hub.dispatch({
    accountId: account.accountId,
    explicitDeviceId: device.deviceId,
    requiredCapabilities: ['browser.interact'],
    kind: 'action',
    payload: { action: {
      id: 'relay-external-denied',
      capability: 'browser.interact',
      risk: 'external',
      input: { operation: 'click', selector: { text: 'Never execute' } },
      provenance: { kind: 'chatgpt', source: 'relay-e2e' }
    } }
  });
  await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === denied.delivery.seq);
  const deniedResult = await resultService.getResult(device.deviceId, denied.delivery.seq);
  assert.equal((deniedResult?.result as any)?.ok, false);
  assert.equal((deniedResult?.result as any)?.provider, 'policy');
  assert.equal((deniedResult?.result as any)?.error?.code, 'APPROVAL_REQUIRED');

  const events = await audit.tail(20);
  assert.equal(events.some((event) => event.capability === 'computer.inspect' && event.result === 'success'), true);
  assert.equal(events.some((event) => event.capability === 'browser.interact' && event.result === 'blocked'), true);

  runner.stop();
  await run;
});


gitTest('session rotation reconnect preserves and executes public filesystem and Git capabilities end-to-end', { timeout: 25_000 }, async (t) => {
  const authorityState = await tempDir(t, 'operator-rotate-action-authority-');
  const deviceState = await tempDir(t, 'operator-rotate-action-device-');
  const projectRoot = await tempDir(t, 'operator-rotate-action-root-');
  const authorityIdentity = new DeviceIdentityStore(authorityState, { platform: 'linux' });
  const deviceIdentity = new DeviceIdentityStore(deviceState, { platform: 'linux' });
  const devices = new DeviceRegistryStore(authorityState);
  const device = await pairDevice(authorityIdentity, devices, deviceIdentity);
  const sessions = new DeviceSessionTokenStore(authorityState, authorityIdentity, devices);
  const accounts = new AccountDeviceRegistry(authorityState, devices);
  const deliveries = new RelayDeliveryStore(authorityState);
  const account = await accounts.resolveOrCreateAccount({ issuer: 'operator-test', subject: 'rotation-actions-e2e' });
  await accounts.bindDevice(account.accountId, device.deviceId);

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' });
  await fs.mkdir(path.join(projectRoot, 'src'));
  await fs.writeFile(path.join(projectRoot, 'safe.txt'), 'base\n');
  execFileSync('git', ['add', 'safe.txt'], { cwd: projectRoot, stdio: 'ignore' });
  await fs.writeFile(path.join(projectRoot, 'safe.txt'), 'changed\n');

  const hub = new RelayHub({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, accounts, deliveries });
  const resultService = new RelayResultService({ stateDir: authorityState, identity: authorityIdentity, devices, sessions, deliveries });
  t.after(() => Promise.allSettled([hub.close(), resultService.close()]));
  const hubBound = await hub.listen('127.0.0.1', 0);
  const resultBound = await resultService.listen('127.0.0.1', 0);

  const capabilities = ['file.read', 'file.create', 'git.status', 'git.diff'] as const;
  const initial = await sessions.issue({
    subjectDeviceId: device.deviceId,
    audience: 'operator-relay',
    scopes: ['relay:connect', 'relay:result', ...capabilities.map((capability) => `cap:${capability}`)],
    ttlMs: 60_000
  });
  const tokenFile = path.join(deviceState, 'relay-session.token');
  await fs.writeFile(tokenFile, `${initial.token}\n`, { mode: 0o600 });

  const agentToken = 'c'.repeat(64);
  const runtime = createRuntime({
    allowedRoots: [projectRoot],
    allowedExecutables: ['node'],
    browserAutoLaunch: false,
    windowsPathLeasePath: process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH
  });
  const audit = new AuditLog(deviceState);
  const agent = createLocalAgentServer({
    runtime,
    token: agentToken,
    audit,
    permissions: {
      allowedCapabilities: [...capabilities],
      allowedRoots: [projectRoot],
      allowExternalWrites: false,
      allowSystemChanges: false,
      allowDestructive: false
    }
  });
  const agentBound = await agent.listen('127.0.0.1', 0);
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));

  const runner = new LocalAgentRelayRunner({
    stateDir: deviceState,
    relayUrl: `ws://127.0.0.1:${hubBound.port}/device`,
    resultUrl: `http://127.0.0.1:${resultBound.port}/v1/device-result`,
    sessionTokenFile: tokenFile,
    identity: deviceIdentity,
    localAgentBaseUrl: `http://127.0.0.1:${agentBound.port}`,
    agentToken,
    getSupportedCapabilities: () => runtime.supportedCapabilities(capabilities),
    allowLoopbackInsecure: true
  });
  const run = runner.run();
  t.after(() => runner.stop());

  let firstSessionId = '';
  await waitFor(async () => {
    const online = (await hub.onlineDevices(account.accountId)).find((entry) => entry.deviceId === device.deviceId);
    if (!online || capabilities.some((capability) => !online.capabilities.includes(capability))) return false;
    firstSessionId = online.sessionId;
    return true;
  });

  const rotated = await sessions.rotate(initial.payload.jti, { ttlMs: 60_000 });
  await fs.writeFile(tokenFile, `${rotated.token}\n`, { mode: 0o600 });
  runner.reconnect();

  await waitFor(async () => {
    const online = (await hub.onlineDevices(account.accountId)).find((entry) => entry.deviceId === device.deviceId);
    return Boolean(
      online
      && online.sessionId !== firstSessionId
      && capabilities.every((capability) => online.capabilities.includes(capability))
    );
  });

  async function execute(capability: typeof capabilities[number], risk: 'read' | 'write', input: Record<string, unknown>) {
    const dispatched = await hub.dispatch({
      accountId: account.accountId,
      explicitDeviceId: device.deviceId,
      requiredCapabilities: [capability],
      kind: 'action',
      payload: {
        publicBoundary: true,
        action: {
          id: `rotation-${capability.replace('.', '-')}`,
          capability,
          risk,
          input,
          provenance: { kind: 'chatgpt', source: 'rotation-actions-e2e' }
        }
      }
    });
    await waitFor(async () => (await hub.deliveryCursor(device.deviceId)).lastAckedSeq === dispatched.delivery.seq);
    const stored = await resultService.getResult(device.deviceId, dispatched.delivery.seq);
    assert.ok(stored, capability);
    return (stored.result as any);
  }

  const created = await execute('file.create', 'write', { path: 'src/after-rotation.txt', content: 'after rotation' });
  assert.equal(created.ok, true, created.error?.message);

  const read = await execute('file.read', 'read', { path: '.\\src\\after-rotation.txt', encoding: 'utf8' });
  assert.equal(read.ok, true, read.error?.message);
  assert.equal(read.output?.content, 'after rotation');

  const status = await execute('git.status', 'read', { cwd: projectRoot });
  assert.equal(status.ok, true, status.error?.message);
  assert.equal(status.output?.entries?.some((entry: any) => entry.path === 'safe.txt'), true);

  const diff = await execute('git.diff', 'read', { cwd: projectRoot, paths: ['safe.txt'], publicLiteralFiles: true });
  assert.equal(diff.ok, true, diff.error?.message);
  assert.match(String(diff.output?.stdout), /changed/);

  const events = await audit.tail(50);
  for (const capability of capabilities) {
    assert.equal(events.some((event) => event.capability === capability && event.result === 'success'), true, capability);
  }

  runner.stop();
  await run;
});
