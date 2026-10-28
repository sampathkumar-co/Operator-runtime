import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKernel } from '../src/core/agent-kernel.ts';
import { canonicalJson } from '../src/core/action-identity.ts';
import { ResourceLeaseStore } from '../src/core/resource-leases.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { TaskOrchestrator } from '../src/core/task-orchestrator.ts';
import { TaskStore } from '../src/core/task-store.ts';
import type { SemanticTaskGoal } from '../src/core/task-orchestrator.ts';
import type {
  ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore, PermissionProfile,
  ProviderReconciliationRequest, ProviderReconciliationResult
} from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 1, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const passing = (kind: string) => [{ kind, status: 'pass' as const, message: 'Synthetic provider produced typed state.', timestamp: new Date().toISOString() }];

class PortableSyntheticProvider implements CapabilityProvider {
  readonly name: string;
  readonly capabilities: string[];
  readonly completedMutations = new Map<string, ActionResult>();
  readonly calls = new Map<string, number>();
  fileContent = '';
  browserUrl = 'https://example.test/start';
  dockerState = 'running';
  appValue = 'before';

  constructor(name: string, capabilities: string[]) { this.name = name; this.capabilities = capabilities; }
  supports(action: ActionRequest): boolean { return this.capabilities.includes(action.capability); }
  score(): CapabilityScore { return SCORE; }
  resolveRisk(action: ActionRequest): ActionRisk {
    if (['file.create'].includes(action.capability)) return 'write';
    if (action.capability === 'docker.manage') return 'system';
    if (['app.operate', 'browser.interact'].includes(action.capability)) return 'external';
    if (action.capability === 'browser.navigate') return 'write';
    return 'read';
  }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls.set(action.id, (this.calls.get(action.id) ?? 0) + 1);
    const result = this.result(action);
    if (action.risk !== 'read' && result.ok) this.completedMutations.set(action.id, structuredClone(result));
    return result;
  }
  async reconcile(request: ProviderReconciliationRequest): Promise<ProviderReconciliationResult> {
    const result = this.completedMutations.get(request.action.id);
    return result
      ? { status: 'completed', result: structuredClone(result), evidence: passing('synthetic_reconciliation') }
      : { status: 'not_applied', evidence: passing('synthetic_reconciliation') };
  }
  private result(action: ActionRequest): ActionResult {
    const success = (output: unknown): ActionResult => ({
      ok: true, capability: action.capability, provider: this.name,
      output, evidence: passing(`synthetic_${action.capability}`), durationMs: 0
    });
    switch (action.capability) {
      case 'file.list': return success({ entries: [] });
      case 'file.create':
        this.fileContent = String(action.input.content);
        return success({ created: true, sha256: sha(this.fileContent), size: Buffer.byteLength(this.fileContent) });
      case 'file.read': return success({ content: this.fileContent, sha256: sha(this.fileContent), size: Buffer.byteLength(this.fileContent) });
      case 'git.status': return success({ clean: false, entries: [{ path: 'portable.txt', status: '??' }] });
      case 'project.inspect': return success({ kind: 'node', manifests: ['package.json'] });
      case 'project.command.inspect': return success({ commands: [{ id: 'portable-test', kind: 'test', risk: 'read' }] });
      case 'project.command.run': return success({
        command: { id: 'portable-test', kind: 'test' }, execution: { exitCode: 0 }, validation: { passed: true }
      });
      case 'docker.inspect': {
        const fingerprint = sha(`docker:${this.dockerState}`);
        return success({ scope: 'project', fingerprint, services: [{ service: 'web', containers: 1, states: [this.dockerState] }] });
      }
      case 'docker.manage': {
        this.dockerState = action.input.operation === 'stop' ? 'exited' : 'running';
        return success({ operation: action.input.operation, beforeFingerprint: action.input.expectedCurrentFingerprint,
          afterFingerprint: sha(`docker:${this.dockerState}`), states: [{ service: 'web', containers: 1, states: [this.dockerState] }] });
      }
      case 'postgres.inspect': return action.input.operation === 'profiles'
        ? success({ profiles: [{ id: 'portable-db', endpoint: 'loopback' }] })
        : success({ profileId: 'portable-db', operation: 'columns', schema: 'public', table: 'items',
          rows: [{ column_name: 'id' }, { column_name: 'note' }] });
      case 'postgres.select': return success({ profileId: 'portable-db', schema: 'public', table: 'items',
        columns: ['id', 'note'], rowCount: 1, limit: 10, offset: 0, rows: [{ id: '1', note: 'redacted-by-normalizer' }] });
      case 'app.inspect': return success({ elements: [{
        name: 'Portable editor', automation_id: 'portable-editor', class_name: 'Edit', control_type: 'Edit', process_id: 4242,
        patterns: { invoke: false, value: true, selection_item: false, expand_collapse: false, scroll: false, legacy_iaccessible: false },
        value: this.appValue
      }] });
      case 'app.operate':
        this.appValue = String(action.input.value);
        return success({ operation: action.input.operation, postcondition: { verified: true, actual_value: this.appValue } });
      case 'browser.inspect': return action.input.targetId
        ? success({ target: { id: 'tab-1', type: 'page', url: this.browserUrl } })
        : success({ tabs: [{ id: 'tab-1', type: 'page', url: this.browserUrl }] });
      case 'browser.navigate':
        this.browserUrl = String(action.input.url);
        return success({ targetId: 'tab-1', url: this.browserUrl });
      case 'browser.interact': {
        const target = action.input.target as Record<string, unknown>;
        const targetId = String(action.input.targetId);
        return success({ targetId, operation: 'click', download: {
          state: 'completed', artifactStatus: 'hashed', artifactSha256: sha('portable-download'), artifactBytes: 17,
          initiatingTargetId: targetId, actionTargetDigest: sha(canonicalJson({ targetId, target })),
          suggestedFilename: 'portable.bin', completedAt: new Date().toISOString()
        } });
      }
      default: throw new Error(`Unsupported synthetic capability ${action.capability}`);
    }
  }
}

test('C05-12 seven heterogeneous typed goals execute through TaskOrchestrator and AgentKernel without native helpers', async t => {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wave2-portable-e2e-state-')));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wave2-portable-e2e-root-')));
  t.after(() => Promise.all([fs.rm(state, { recursive: true, force: true }), fs.rm(root, { recursive: true, force: true })]));
  const providers = [
    new PortableSyntheticProvider('synthetic.file-git', ['file.list', 'file.create', 'file.read', 'git.status']),
    new PortableSyntheticProvider('synthetic.build-test', ['project.inspect', 'project.command.inspect', 'project.command.run']),
    new PortableSyntheticProvider('synthetic.docker', ['docker.inspect', 'docker.manage']),
    new PortableSyntheticProvider('synthetic.postgres', ['postgres.inspect', 'postgres.select']),
    new PortableSyntheticProvider('synthetic.uia', ['app.inspect', 'app.operate']),
    new PortableSyntheticProvider('synthetic.browser', ['browser.inspect', 'browser.navigate']),
    new PortableSyntheticProvider('synthetic.download', ['browser.interact'])
  ];
  const runtime = providers.reduce((value, provider) => value.register(provider), new OperatorRuntime());
  const store = new TaskStore(state);
  const allowedCapabilities = providers.flatMap(provider => provider.capabilities);
  const permissions: PermissionProfile = {
    allowedCapabilities, allowedRoots: [root], allowDestructive: false,
    allowExternalWrites: false, allowSystemChanges: false
  };
  const makeOrchestrator = () => {
    const kernel = new AgentKernel({ stateDir: state, runtime, leases: new ResourceLeaseStore(state) });
    return new TaskOrchestrator({
      runtime, store, permissions,
      executeAction: (action, granted, context) => kernel.execute(action, granted, context)
    });
  };
  const goals: Array<{ label: string; goal: SemanticTaskGoal }> = [
    { label: 'file-git', goal: { kind: 'controlled-file-change', root, path: path.join(root, 'portable.txt'), content: 'portable\n' } },
    { label: 'build-test', goal: { kind: 'trusted-project-command', root, commandKind: 'test' } },
    { label: 'docker', goal: { kind: 'docker-lifecycle', root, operation: 'stop', services: ['web'] } },
    { label: 'postgres', goal: { kind: 'postgres-select', root, profileId: 'portable-db', table: 'items', columns: ['id', 'note'], limit: 10 } },
    { label: 'application', goal: { kind: 'app-operation', operation: 'set_value', selector: { automationId: 'portable-editor', controlType: 'Edit' }, value: 'after' } },
    { label: 'browser', goal: { kind: 'browser-navigation', url: 'https://example.test/portable' } },
    { label: 'download', goal: { kind: 'browser-download', targetId: 'tab-1', origin: 'https://example.test',
      target: { role: 'link', name: 'Portable' }, expectedSha256: sha('portable-download'), expectedSuggestedFilename: 'portable.bin' } }
  ];
  for (const item of goals) {
    let orchestrator = makeOrchestrator();
    const submitted = await orchestrator.submit({
      objective: `Exercise portable ${item.label} production workflow.`, authorizedScope: [root, 'browser:https://example.test', 'app:portable-editor'],
      successConditions: [`${item.label} typed outcome is independently established`], goal: item.goal, maxSteps: 12
    });
    let completed = await orchestrator.run(submitted.id);
    let restarts = 0;
    while (completed.state === 'BLOCKED' && restarts < 4) {
      const blockedAction = completed.execution!.records.findLast(record => record.state === 'BLOCKED')!;
      orchestrator = makeOrchestrator();
      completed = await orchestrator.resume(submitted.id, [blockedAction.actionId]);
      restarts += 1;
    }
    assert.equal(completed.state, 'VERIFIED', item.label);
    assert.ok(completed.evidence.some(e => e.kind === 'independent_task_verification' && e.status === 'pass'), item.label);
    assert.ok(completed.execution?.records.filter(record => record.state === 'SUCCEEDED')
      .every(record => record.evidence.some(e => e.kind === 'kernel_verification' && e.status === 'pass')), item.label);
  }
  for (const provider of providers) {
    for (const actionId of provider.completedMutations.keys()) {
      assert.equal(provider.calls.get(actionId), 1, `mutation ${actionId} was replayed`);
    }
  }
});
