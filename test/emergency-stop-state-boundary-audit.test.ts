import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmergencyStopStore } from '../apps/local-agent/src/emergency-stop.ts';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

async function makeSymlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

test('EmergencyStopStore writes and reloads a regular single-link state file without temp residue', async (t) => {
  const state = await tempDir(t, 'operator-emergency-roundtrip-');
  const store = new EmergencyStopStore(state);
  const engaged = await store.engage('manual safety stop');
  assert.equal(engaged.engaged, true);
  assert.equal((await new EmergencyStopStore(state).status()).engaged, true);

  const file = path.join(state, 'emergency-stop.json');
  const stat = await fs.lstat(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  assert.deepEqual(await fs.readdir(state), ['emergency-stop.json']);
});

test('EmergencyStopStore refuses a symlinked forged disengaged state', async (t) => {
  const state = await tempDir(t, 'operator-emergency-link-state-');
  const outside = await tempDir(t, 'operator-emergency-link-outside-');
  const target = path.join(outside, 'forged.json');
  const forged = JSON.stringify({ version: 1, engaged: false, clearedAt: '2026-09-10T05:00:00.000Z' });
  await fs.writeFile(target, forged, { mode: 0o600 });
  const link = path.join(state, 'emergency-stop.json');
  if (!(await makeSymlinkOrSkip(t, target, link))) return;

  await assert.rejects(
    () => new EmergencyStopStore(state).status(),
    (error: any) => error?.code === 'EMERGENCY_STOP_STATE_INVALID'
  );
  assert.equal(await fs.readFile(target, 'utf8'), forged);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('EmergencyStopStore write refuses to replace a symlink and leaves its target untouched', async (t) => {
  const state = await tempDir(t, 'operator-emergency-write-link-state-');
  const outside = await tempDir(t, 'operator-emergency-write-link-outside-');
  const target = path.join(outside, 'sentinel.json');
  const sentinel = JSON.stringify({ version: 1, engaged: false, clearedAt: '2026-09-10T05:00:00.000Z' });
  await fs.writeFile(target, sentinel, { mode: 0o600 });
  const link = path.join(state, 'emergency-stop.json');
  if (!(await makeSymlinkOrSkip(t, target, link))) return;

  await assert.rejects(
    () => new EmergencyStopStore(state).engage('must not follow link'),
    (error: any) => error?.code === 'EMERGENCY_STOP_STATE_INVALID'
  );
  assert.equal(await fs.readFile(target, 'utf8'), sentinel);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('EmergencyStopStore refuses hard-linked state authority', async (t) => {
  const state = await tempDir(t, 'operator-emergency-hardlink-state-');
  const outside = await tempDir(t, 'operator-emergency-hardlink-outside-');
  const target = path.join(outside, 'forged.json');
  const body = JSON.stringify({ version: 1, engaged: false, clearedAt: '2026-09-10T05:00:00.000Z' });
  await fs.writeFile(target, body, { mode: 0o600 });
  const linked = path.join(state, 'emergency-stop.json');
  try {
    await fs.link(target, linked);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => new EmergencyStopStore(state).status(),
    (error: any) => error?.code === 'EMERGENCY_STOP_STATE_INVALID'
  );
  assert.ok((await fs.lstat(linked)).nlink > 1);
  assert.equal(await fs.readFile(target, 'utf8'), body);
});

test('EmergencyStopStore rejects malformed persisted authority fields instead of coercing them', async (t) => {
  const state = await tempDir(t, 'operator-emergency-shape-');
  const file = path.join(state, 'emergency-stop.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    engaged: true,
    engagedAt: 0,
    reason: 'forged',
    attackerField: 'ignored-before-hardening'
  }), { mode: 0o600 });

  await assert.rejects(
    () => new EmergencyStopStore(state).status(),
    (error: any) => error?.code === 'EMERGENCY_STOP_STATE_INVALID'
  );
});

test('corrupt emergency-stop authority fails closed at the execution boundary', async (t) => {
  const root = await tempDir(t, 'operator-emergency-execute-root-');
  const state = await tempDir(t, 'operator-emergency-execute-state-');
  const outside = await tempDir(t, 'operator-emergency-execute-outside-');
  const target = path.join(outside, 'forged.json');
  await fs.writeFile(target, JSON.stringify({ version: 1, engaged: false }), { mode: 0o600 });
  if (!(await makeSymlinkOrSkip(t, target, path.join(state, 'emergency-stop.json')))) return;

  const token = 'e'.repeat(64);
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const agent = createLocalAgentServer({
    runtime,
    token,
    emergencyStop: new EmergencyStopStore(state),
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const response = await fetch(`http://127.0.0.1:${bound.port}/v1/execute`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: { id: 'must-not-run', capability: 'computer.inspect', risk: 'read', input: {}, provenance: { kind: 'chatgpt' } }
    })
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).error.code, 'EMERGENCY_STOP_STATE_INVALID');
});


const EMERGENCY_SCORE: CapabilityScore = {
  reliability: 1,
  latency: 0,
  determinism: 1,
  security: 1,
  reversibility: 1,
  informationQuality: 1,
  interactionCost: 0
};

class EmergencyAbortProbeProvider implements CapabilityProvider {
  readonly name = 'test.emergency-abort-probe';
  started!: () => void;
  readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve; });
  supports(action: ActionRequest): boolean { return action.capability === 'computer.inspect'; }
  score(): CapabilityScore { return EMERGENCY_SCORE; }
  resolveRisk(): ActionRequest['risk'] { return 'read'; }
  async execute(action: ActionRequest, context?: CapabilityExecutionContext): Promise<ActionResult> {
    this.started();
    if (!context?.signal?.aborted) {
      await new Promise<void>((resolve) => context?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    }
    return {
      ok: false,
      capability: action.capability,
      provider: this.name,
      evidence: [{ kind: 'emergency_abort', status: 'fail', message: 'Provider observed the emergency abort signal.', timestamp: new Date().toISOString() }],
      error: {
        code: 'EXECUTION_ABORTED',
        message: 'Provider execution was aborted by emergency stop.',
        retryable: false,
        sideEffectState: 'none',
        executionPhase: 'dispatched'
      },
      durationMs: 0
    };
  }
}

test('engaging emergency stop aborts an already-dispatched local provider request', async (t) => {
  const state = await tempDir(t, 'operator-emergency-inflight-state-');
  const token = 'i'.repeat(64);
  const recoveryToken = 'r'.repeat(64);
  const provider = new EmergencyAbortProbeProvider();
  const runtime = new OperatorRuntime().register(provider);
  const emergencyStop = new EmergencyStopStore(state);
  const agent = createLocalAgentServer({
    runtime,
    token,
    recoveryToken,
    emergencyStop,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const execute = fetch(`${base}/v1/execute`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      action: {
        id: 'inflight-emergency-abort',
        capability: 'computer.inspect',
        risk: 'read',
        input: {},
        provenance: { kind: 'chatgpt' }
      }
    })
  });

  await provider.startedPromise;
  const stopped = await fetch(`${base}/v1/emergency-stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'test emergency abort' })
  });
  assert.equal(stopped.status, 200);

  const response = await execute;
  assert.equal(response.status, 409);
  const body = await response.json() as any;
  assert.equal(body.error.code, 'EXECUTION_ABORTED');
  assert.equal((await emergencyStop.status()).engaged, true);
});


test('local-agent boot freezes mutable recovery and periodic orchestration behind persisted emergency-stop authority', async () => {
  const source = await fs.readFile(path.resolve('apps/local-agent/src/main.ts'), 'utf8');
  const statusRead = source.indexOf('const startupEmergencyStatus = await emergencyStop.status()');
  const kernelAbortBinding = source.indexOf('globalAbortSignal: () => emergencyExecutionGeneration.signal');
  const organizationRecovery = source.indexOf('organizationRecovery = await organizations.recoverPendingCompensations()');
  const studioRecovery = source.indexOf('recoveredStudioRuns = startupEmergencyStatus.engaged ? 0 : await studioExecutor.recoverInterrupted()');
  const periodicGate = source.indexOf('if (!startupEmergencyStatus.engaged) {\n  desiredStateReconciler.start();\n  eventTicker.start();');
  const relayGate = source.indexOf('if (relayUrl && startupEmergencyStatus.engaged)');

  assert.ok(statusRead >= 0, 'persisted emergency-stop state must be read during startup');
  assert.ok(kernelAbortBinding > statusRead, 'AgentKernel must inherit the startup emergency generation');
  assert.ok(organizationRecovery > statusRead, 'organization recovery must be ordered after persisted stop authority');
  assert.ok(studioRecovery > statusRead, 'Studio recovery must be ordered after persisted stop authority');
  assert.ok(periodicGate > statusRead, 'periodic internal orchestration must be gated by persisted stop authority');
  assert.ok(relayGate > periodicGate, 'relay startup must remain behind the same persisted stop decision');
  assert.match(source, /if \(!startupEmergencyStatus\.engaged\) \{[\s\S]*?organizationRecovery = await organizations\.recoverPendingCompensations\(\)/);
  assert.match(source, /startupEmergencyStatus\.engaged \? 0 : await studioExecutor\.recoverInterrupted\(\)/);
});
