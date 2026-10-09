import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApprovalStore } from '../apps/local-agent/src/approval-store.ts';
import { SessionApprovalStore } from '../apps/local-agent/src/session-approval.ts';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const SCORE: CapabilityScore = { reliability: 1, latency: 1, determinism: 1, security: 1, reversibility: 1, informationQuality: 1, interactionCost: 0 };
class TabProvider implements CapabilityProvider {
  readonly name = 'test.tab-selection';
  selected = false;
  operateCalls = 0;
  supports(action: ActionRequest) { return ['app.inspect', 'app.operate'].includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    if (action.capability === 'app.operate') {
      this.operateCalls++;
      this.selected = true;
      return { ok: true, capability: action.capability, provider: this.name, output: {
        operation: 'select', postcondition: { verified: true }
      }, evidence: [], durationMs: 0 };
    }
    return { ok: true, capability: action.capability, provider: this.name, output: {
      elements: [{ name: 'Second tab', automation_id: 'chrome-tab-2', class_name: 'TabItem',
        control_type: 'TabItem', process_id: 77, selected: this.selected,
        patterns: { selection_item: true, value: false, invoke: false, expand_collapse: false, scroll: false, legacy_iaccessible: false } }]
    }, evidence: [], durationMs: 0 };
  }
}

test('direct Chrome-style tab selection and durable task both require actual approval; recovery token and guessed action ID cannot grant it', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-p0-approval-parity-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const provider = new TabProvider();
  const runtime = new OperatorRuntime().register(provider);
  const tasks = new TaskStore(state);
  const permissions = { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [],
    allowExternalWrites: false, allowDestructive: false, allowSystemChanges: false };
  const approvals = new ApprovalStore(state);
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 'p'.repeat(64), recoveryToken = 'r'.repeat(64);
  const agent = createLocalAgentServer({ runtime, token, recoveryToken, approvals, permissions, tasks, taskOrchestrator, inlineApprovalWaitMs: 10 });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const { port } = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const selector = { automationId: 'chrome-tab-2', controlType: 'TabItem', processId: 77 };
  const direct = await fetch(`${base}/v1/execute`, { method: 'POST', headers, body: JSON.stringify({ action: {
    id: 'select-other-chrome-tab', capability: 'app.operate', risk: 'external',
    input: { operation: 'select', selector }, provenance: { kind: 'chatgpt' }
  } }) });
  assert.equal(direct.status, 409);
  assert.equal((await direct.json() as any).error?.code, 'APPROVAL_REQUIRED');
  assert.equal(provider.operateCalls, 0);
  const submit = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({
    objective: 'Select another Chrome tab', run: true,
    successConditions: ['tab selected and independently verified'],
    goal: { kind: 'app-operation', operation: 'select', selector }
  }) });
  const submitted = await submit.json() as any;
  assert.equal(submit.status, 200, JSON.stringify(submitted));
  assert.equal(submitted.task.state, 'BLOCKED');
  assert.equal(provider.operateCalls, 0);
  const blocked = submitted.task.execution.records.find((r: any) => r.state === 'BLOCKED');
  assert.equal(blocked.capability, 'app.operate');
  const bypass = await fetch(`${base}/v1/tasks/${submitted.task.id}/resume`, { method: 'POST',
    headers: { ...headers, 'x-operator-recovery-token': recoveryToken },
    body: JSON.stringify({ approvedActionId: blocked.actionId })
  });
  const bypassResult = await bypass.json() as any;
  assert.equal(bypass.status, 409);
  assert.equal(bypassResult.error?.code, 'TASK_APPROVAL_DECISION_REQUIRED');
  assert.equal(provider.operateCalls, 0, 'recovery credential must never substitute for an explicit action approval');
  const pending = (await approvals.list()).find(r => r.actionId === blocked.actionId);
  assert.equal(pending?.status, 'pending');
  await approvals.approve(blocked.actionId, pending!.approvalRequestId);
  const resume = await fetch(`${base}/v1/tasks/${submitted.task.id}/resume`, { method: 'POST', headers,
    body: JSON.stringify({}) });
  const completed = await resume.json() as any;
  assert.equal(resume.status, 200, JSON.stringify(completed));
  assert.equal(completed.task.state, 'VERIFIED');
  assert.equal(provider.operateCalls, 1);
  assert.equal((await approvals.list()).find(r => r.actionId === blocked.actionId)?.status, 'consumed');
});

test('cross-device approval cannot authorize the same blocked application step inside a workflow', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-p0-workflow-approval-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const provider = new TabProvider();
  const runtime = new OperatorRuntime().register(provider);
  const tasks = new TaskStore(state);
  const permissions = { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [],
    allowExternalWrites: false, allowDestructive: false, allowSystemChanges: false };
  const approvals = new ApprovalStore(state);
  const orchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 'w'.repeat(64), recoveryToken = 'k'.repeat(64);
  const agent = createLocalAgentServer({ runtime, token, recoveryToken, approvals, permissions, tasks, taskOrchestrator: orchestrator, inlineApprovalWaitMs: 10 });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const { port } = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const authorityA = { accountId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222', generation: 8 };
  const authorityB = { ...authorityA, deviceId: '33333333-3333-4333-8333-333333333333' };
  const selector = { automationId: 'chrome-tab-2', controlType: 'TabItem', processId: 77 };
  const submit = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({
    objective: 'Select a tab as a substep of a durable workflow',
    run: true, approvalAuthority: authorityA,
    successConditions: ['exact action approved', 'tab selection verified'],
    goal: { kind: 'semantic-workflow', steps: [{ kind: 'app-operation', operation: 'select', selector }] }
  }) });
  const body = await submit.json() as any;
  assert.equal(submit.status, 200, JSON.stringify(body));
  assert.equal(body.task.state, 'BLOCKED');
  const blocked = body.task.execution.records.find((r: any) => r.state === 'BLOCKED');
  assert.equal(blocked.capability, 'app.operate');
  assert.equal(provider.operateCalls, 0);
  const pending = (await approvals.list()).find(r => r.actionId === blocked.actionId);
  assert.equal(pending?.status, 'pending');
  await approvals.approve(blocked.actionId, pending!.approvalRequestId);
  const wrongDevice = await fetch(`${base}/v1/tasks/${body.task.id}/resume`, {
    method: 'POST', headers,
    body: JSON.stringify({ approvalAuthority: authorityB })
  });
  const outcome = await wrongDevice.json() as any;
  assert.equal(wrongDevice.status, 200, JSON.stringify(outcome));
  assert.equal(outcome.task.state, 'BLOCKED');
  assert.equal(provider.operateCalls, 0, 'approval for another device must not authorize the workflow');
  const latestPending = (await approvals.list()).find(r => r.actionId === blocked.actionId);
  assert.equal(latestPending?.status, 'pending');
  const unauthorizedRepeat = await fetch(`${base}/v1/tasks/${body.task.id}/resume`, {
    method: 'POST', headers, body: JSON.stringify({ approvalAuthority: authorityB })
  });
  assert.equal((await unauthorizedRepeat.json() as any).task.state, 'BLOCKED');
  assert.equal(provider.operateCalls, 0);
});

test('an explicitly approved session authorizes direct and durable Chrome-style actions only under the same device authority', async t => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-p0-session-parity-'));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const provider = new TabProvider();
  const runtime = new OperatorRuntime().register(provider);
  const tasks = new TaskStore(state);
  const permissions = { allowedCapabilities: ['app.inspect', 'app.operate'], allowedRoots: [],
    allowExternalWrites: false, allowDestructive: false, allowSystemChanges: false };
  const approvals = new ApprovalStore(state);
  const sessionApprovals = new SessionApprovalStore();
  const taskOrchestrator = new TaskOrchestrator({ runtime, store: tasks, permissions });
  const token = 'v'.repeat(64);
  const agent = createLocalAgentServer({
    runtime, token, approvals, sessionApprovals, permissions, tasks, taskOrchestrator, inlineApprovalWaitMs: 10
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const { port } = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const authority = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', generation: 3 };
  const otherDevice = { ...authority, deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
  const selector = { automationId: 'chrome-tab-2', controlType: 'TabItem', processId: 77 };
  const grantAction: ActionRequest = { id: 'session-grant-tab', capability: 'app.operate', risk: 'external',
    input: { operation: 'select', selector }, provenance: { kind: 'chatgpt' } };
  const pending = await approvals.register(grantAction, authority);
  const approved = await approvals.approve(grantAction.id, pending.approvalRequestId);
  sessionApprovals.grant(approved, permissions);
  assert.equal(sessionApprovals.summary().active, true);

  const invoke = (id: string, approvalAuthority: typeof authority) =>
    fetch(`${base}/v1/execute`, { method: 'POST', headers, body: JSON.stringify({ action: {
      id, capability: 'app.operate', risk: 'external', input: { operation: 'select', selector },
      provenance: { kind: 'chatgpt' }
    }, approvalAuthority }) });
  const direct = await invoke('direct-session-tab', authority);
  assert.equal(direct.status, 200, JSON.stringify(await direct.clone().json()));
  assert.equal((await direct.json() as any).ok, true);
  assert.equal(provider.operateCalls, 1);

  const submitted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({
    objective: 'Select another tab with an explicitly active session grant', run: true,
    approvalAuthority: authority, successConditions: ['postcondition independently verified'],
    goal: { kind: 'app-operation', operation: 'select', selector }
  }) });
  const task = await submitted.json() as any;
  assert.equal(submitted.status, 200, JSON.stringify(task));
  assert.equal(task.task.state, 'VERIFIED');
  assert.equal(provider.operateCalls, 2);

  const foreign = await invoke('foreign-device-tab', otherDevice);
  assert.equal(foreign.status, 409);
  assert.equal((await foreign.json() as any).error.code, 'APPROVAL_REQUIRED');
  assert.equal(provider.operateCalls, 2);
});
