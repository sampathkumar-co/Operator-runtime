import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DockerProvider } from '../src/capabilities/docker.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const canonical = await fs.realpath(dir);
  t.after(() => fs.rm(canonical, { recursive: true, force: true }));
  return canonical;
}

type FakeContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  project?: string;
  service?: string;
  workingDir?: string;
  secretLabel?: string;
};

type FakeState = {
  host: string;
  version: string;
  containers: FakeContainer[];
};

async function makeFakeDocker(t: test.TestContext, state: FakeState): Promise<{ executable: string; prefix: string[]; statePath: string; logPath: string }> {
  const dir = await tempDir(t, 'operator-fake-docker-');
  const statePath = path.join(dir, 'state.json');
  const logPath = path.join(dir, 'calls.ndjson');
  const scriptPath = path.join(dir, 'fake-docker.cjs');
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
  await fs.writeFile(scriptPath, `
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const argv = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ argv, dockerHost: process.env.DOCKER_HOST ?? null, dockerContext: process.env.DOCKER_CONTEXT ?? null, composeDisableEnvFile: process.env.COMPOSE_DISABLE_ENV_FILE ?? null }) + '\\n');
const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = (value) => fs.writeFileSync(statePath, JSON.stringify(value, null, 2));
if (argv[0] === 'context' && argv[1] === 'show') { process.stdout.write('default\\n'); process.exit(0); }
if (argv[0] === 'context' && argv[1] === 'inspect') { process.stdout.write(JSON.stringify(load().host) + '\\n'); process.exit(0); }
let args = argv;
if (args[0] === '--context') args = args.slice(2);
const command = args[0];
const state = load();
if (command === 'version') { process.stdout.write(JSON.stringify(state.version) + '\\n'); process.exit(0); }
if (command === 'ps') {
  const composeOnly = args.includes('--filter');
  const containers = composeOnly ? state.containers.filter((item) => item.project && item.service && item.workingDir) : state.containers;
  for (const item of containers) {
    if (composeOnly) process.stdout.write(JSON.stringify(item.id) + '\\n');
    else process.stdout.write(JSON.stringify({ ID: item.id, Names: item.name, Image: item.image, State: item.state, Status: item.state === 'running' ? 'Up 1 minute' : 'Exited (0)', Ports: '' }) + '\\n');
  }
  process.exit(0);
}
if (command === 'inspect') {
  const ids = args.slice(args.indexOf('--format') + 2);
  for (const id of ids) {
    const item = state.containers.find((candidate) => candidate.id === id);
    if (!item) { process.stderr.write('missing container'); process.exit(1); }
    const values = [item.id, '/' + item.name, item.image, item.state, item.project ?? '', item.service ?? '', item.workingDir ?? ''];
    process.stdout.write(values.map((value) => JSON.stringify(value)).join('\\t') + '\\n');
  }
  process.exit(0);
}
if (command === 'start' || command === 'stop' || command === 'restart') {
  const ids = args.slice(1);
  for (const id of ids) {
    const item = state.containers.find((candidate) => candidate.id === id);
    if (!item) { process.stderr.write('missing container'); process.exit(1); }
    item.state = command === 'stop' ? 'exited' : 'running';
  }
  save(state);
  process.stdout.write(ids.join('\\n') + '\\n');
  process.exit(0);
}
process.stderr.write('unsupported fake docker invocation: ' + JSON.stringify(argv));
process.exit(2);
`);
  return { executable: process.execPath, prefix: [scriptPath], statePath, logPath };
}

async function readCalls(logPath: string): Promise<Array<{ argv: string[]; dockerHost: string | null; dockerContext: string | null; composeDisableEnvFile: string | null }>> {
  try {
    return (await fs.readFile(logPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function container(projectRoot: string, state = 'exited'): FakeContainer {
  return {
    id: 'a'.repeat(64),
    name: 'demo-web-1',
    image: 'example/web:1',
    state,
    project: 'demo',
    service: 'web',
    workingDir: projectRoot,
    secretLabel: 'must-never-be-returned'
  };
}

test('Docker project inspection uses only local context and Docker labels, never repository Compose config', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-project-');
  await fs.writeFile(path.join(projectRoot, 'compose.yaml'), 'include:\n  - ../../outside-secret.yaml\nservices:\n  web:\n    image: example/web:1\n');
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock',
    version: '27.5.1',
    containers: [container(projectRoot)]
  });
  const provider = new DockerProvider({ allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });
  const result = await provider.execute({
    id: 'docker-project-inspect', capability: 'docker.inspect', risk: 'read', input: { path: projectRoot }, provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, true, result.error?.message);
  const output = result.output as any;
  assert.equal(output.context.local, true);
  assert.equal(output.context.host, 'unix:///var/run/docker.sock');
  assert.equal(output.services[0].service, 'web');
  assert.match(output.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(output), /must-never-be-returned/);
  const calls = await readCalls(fake.logPath);
  assert.equal(calls.some((call) => call.argv.includes('compose')), false);
  assert.equal(calls.every((call) => call.dockerHost === null && call.dockerContext === null), true);
  assert.equal(calls.every((call) => call.composeDisableEnvFile === '1'), true);
});

test('Docker lifecycle management requires fresh fingerprint and verifies start/stop/restart states', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-lifecycle-');
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock',
    version: '27.5.1',
    containers: [container(projectRoot)]
  });
  const provider = new DockerProvider({ allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });
  const inspect = async () => provider.execute({ id: crypto.randomUUID(), capability: 'docker.inspect', risk: 'read', input: { path: projectRoot }, provenance: { kind: 'runtime' } });
  const initial = await inspect();
  assert.equal(initial.ok, true);
  let fingerprint = String((initial.output as any).fingerprint);

  const started = await provider.execute({
    id: 'docker-start', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'start', services: ['web'], expectedCurrentFingerprint: fingerprint },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(started.ok, true, started.error?.message);
  assert.deepEqual((started.output as any).states, [{ service: 'web', containers: 1, states: ['running'] }]);

  const afterStart = await inspect();
  fingerprint = String((afterStart.output as any).fingerprint);
  const stopped = await provider.execute({
    id: 'docker-stop', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'stop', services: ['web'], expectedCurrentFingerprint: fingerprint },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(stopped.ok, true, stopped.error?.message);
  assert.deepEqual((stopped.output as any).states, [{ service: 'web', containers: 1, states: ['exited'] }]);

  const afterStop = await inspect();
  fingerprint = String((afterStop.output as any).fingerprint);
  const restarted = await provider.execute({
    id: 'docker-restart', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'restart', services: ['web'], expectedCurrentFingerprint: fingerprint },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(restarted.ok, true, restarted.error?.message);
  assert.deepEqual((restarted.output as any).states, [{ service: 'web', containers: 1, states: ['running'] }]);
});

test('Docker management rejects stale state before lifecycle invocation', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-stale-');
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock', version: '27.5.1', containers: [container(projectRoot)]
  });
  const provider = new DockerProvider({ allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });
  const inspected = await provider.execute({ id: 'inspect', capability: 'docker.inspect', risk: 'read', input: { path: projectRoot }, provenance: { kind: 'runtime' } });
  const fingerprint = String((inspected.output as any).fingerprint);
  const state = JSON.parse(await fs.readFile(fake.statePath, 'utf8')) as FakeState;
  state.containers[0].state = 'running';
  await fs.writeFile(fake.statePath, JSON.stringify(state, null, 2));
  const beforeCalls = await readCalls(fake.logPath);
  const result = await provider.execute({
    id: 'stale-start', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'start', services: ['web'], expectedCurrentFingerprint: fingerprint },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'DOCKER_STATE_CHANGED');
  const newCalls = (await readCalls(fake.logPath)).slice(beforeCalls.length);
  assert.equal(newCalls.some((call) => call.argv.includes('start')), false);
});

test('Docker adapter rejects remote contexts and invalid service tokens', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-remote-');
  const fake = await makeFakeDocker(t, {
    host: 'ssh://prod.example.internal', version: '27.5.1', containers: [container(projectRoot)]
  });
  const provider = new DockerProvider({ allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });
  const remote = await provider.execute({ id: 'remote', capability: 'docker.inspect', risk: 'read', input: { path: projectRoot }, provenance: { kind: 'chatgpt' } });
  assert.equal(remote.ok, false);
  assert.equal(remote.error?.code, 'REMOTE_DOCKER_CONTEXT_DENIED');
  const calls = await readCalls(fake.logPath);
  assert.equal(calls.some((call) => call.argv.includes('ps')), false);

  const invalid = await provider.execute({
    id: 'invalid-service', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'start', services: ['web;rm'], expectedCurrentFingerprint: '0'.repeat(64) },
    provenance: { kind: 'chatgpt' }
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'INVALID_DOCKER_SERVICE');
});

test('Docker reconciliation proves start and stop from current project state and refuses to infer restart history', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-reconcile-');
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock',
    version: '27.5.1',
    containers: [container(projectRoot, 'running')]
  });
  const provider = new DockerProvider({ allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix });
  const baseAction = {
    capability: 'docker.manage' as const,
    risk: 'system' as const,
    input: { path: projectRoot, services: ['web'], expectedCurrentFingerprint: '0'.repeat(64) },
    provenance: { kind: 'runtime' as const }
  };

  const start = await provider.reconcile({ action: { ...baseAction, id: 'reconcile-start', input: { ...baseAction.input, operation: 'start' } } });
  assert.equal(start.status, 'completed');
  assert.equal(start.result?.ok, true);
  assert.deepEqual((start.result?.output as any).states, [{ service: 'web', containers: 1, states: ['running'] }]);

  const stopWhileRunning = await provider.reconcile({ action: { ...baseAction, id: 'reconcile-stop-not-applied', input: { ...baseAction.input, operation: 'stop' } } });
  assert.equal(stopWhileRunning.status, 'not_applied');

  const state = JSON.parse(await fs.readFile(fake.statePath, 'utf8')) as FakeState;
  state.containers[0]!.state = 'exited';
  await fs.writeFile(fake.statePath, JSON.stringify(state, null, 2));

  const stop = await provider.reconcile({ action: { ...baseAction, id: 'reconcile-stop', input: { ...baseAction.input, operation: 'stop' } } });
  assert.equal(stop.status, 'completed');
  assert.equal(stop.result?.ok, true);

  const restart = await provider.reconcile({ action: { ...baseAction, id: 'reconcile-restart', input: { ...baseAction.input, operation: 'restart' } } });
  assert.equal(restart.status, 'uncertain', 'final running/exited state alone cannot prove restart history');
});

test('C06 project inventory refuses silent global Compose enumeration truncation', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-overlimit-');
  const containers = Array.from({ length: 101 }, (_, index) => ({
    ...container(projectRoot),
    id: (index + 1).toString(16).padStart(64, '0'),
    name: 'demo-web-' + String(index + 1)
  }));
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock', version: '27.5.1', containers
  });
  const provider = new DockerProvider({
    allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix
  });
  const inspected = await provider.execute({
    id: 'inventory-over-limit', capability: 'docker.inspect', risk: 'read',
    input: { path: projectRoot }, provenance: { kind: 'runtime' }
  });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.error?.code, 'DOCKER_PROJECT_INVENTORY_INCOMPLETE');
  const lifecycle = await provider.execute({
    id: 'manage-over-limit', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, operation: 'start', services: ['web'],
      expectedCurrentFingerprint: '0'.repeat(64) }, provenance: { kind: 'runtime' }
  });
  assert.equal(lifecycle.ok, false);
  assert.equal(lifecycle.error?.code, 'DOCKER_PROJECT_INVENTORY_INCOMPLETE');
  const calls = await readCalls(fake.logPath);
  assert.equal(calls.some((call) => call.argv.includes('start')), false);
});

test('C06 duplicate or malformed Docker Compose IDs cannot make a partial project fingerprint', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-duplicate-inventory-');
  const original = container(projectRoot);
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock', version: '27.5.1',
    containers: [original, { ...original, name: 'same-id-second-container' }]
  });
  const provider = new DockerProvider({
    allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix
  });
  const duplicate = await provider.execute({
    id: 'inventory-duplicate', capability: 'docker.inspect', risk: 'read',
    input: { path: projectRoot }, provenance: { kind: 'runtime' }
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error?.code, 'DOCKER_PROJECT_INVENTORY_INVALID');
  const state = JSON.parse(await fs.readFile(fake.statePath, 'utf8')) as FakeState;
  state.containers = [{ ...original, id: 'not-a-valid-id' }];
  await fs.writeFile(fake.statePath, JSON.stringify(state));
  const malformed = await provider.execute({
    id: 'inventory-malformed', capability: 'docker.inspect', risk: 'read',
    input: { path: projectRoot }, provenance: { kind: 'runtime' }
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error?.code, 'DOCKER_PROJECT_INVENTORY_INVALID');
});

test('C06 distinct Compose project names sharing an authorized directory cannot be managed together', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-ambiguous-compose-root-');
  const first = container(projectRoot);
  const second: FakeContainer = {
    ...first, id: 'b'.repeat(64), project: 'different-project',
    service: 'web', name: 'other-web-1'
  };
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock', version: '27.5.1',
    containers: [first, second]
  });
  const provider = new DockerProvider({
    allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix
  });
  const inspect = await provider.execute({
    id: 'ambiguous-root-inspect', capability: 'docker.inspect', risk: 'read',
    input: { path: projectRoot }, provenance: { kind: 'runtime' }
  });
  assert.equal(inspect.ok, false);
  assert.equal(inspect.error?.code, 'DOCKER_PROJECT_AMBIGUOUS');
  const manage = await provider.execute({
    id: 'ambiguous-root-manage', capability: 'docker.manage', risk: 'system',
    input: { path: projectRoot, services: ['web'], operation: 'stop',
      expectedCurrentFingerprint: '0'.repeat(64) }, provenance: { kind: 'runtime' }
  });
  assert.equal(manage.ok, false);
  assert.equal(manage.error?.code, 'DOCKER_PROJECT_AMBIGUOUS');
  const calls = await readCalls(fake.logPath);
  assert.equal(calls.some((call) => call.argv.includes('stop')), false,
    'no container in either Compose project may be touched');
});

test('C06 Docker daemon inspection rejects type-confused container rows instead of string coercion', async (t) => {
  const projectRoot = await tempDir(t, 'operator-docker-coerced-daemon-');
  const fake = await makeFakeDocker(t, {
    host: 'unix:///var/run/docker.sock', version: '27.5.1',
    containers: [{ ...container(projectRoot), id: ['a'.repeat(64)] as unknown as string }]
  });
  const provider = new DockerProvider({
    allowedRoots: [projectRoot], dockerExecutable: fake.executable, dockerArgsPrefix: fake.prefix
  });
  const result = await provider.execute({
    id: 'malformed-daemon-read', capability: 'docker.inspect', risk: 'read',
    input: {}, provenance: { kind: 'runtime' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'DOCKER_OUTPUT_INVALID');
});
