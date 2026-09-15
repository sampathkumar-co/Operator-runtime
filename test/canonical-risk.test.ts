import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { CAPABILITY_RISK_RULES } from '../src/core/capability-policy.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

const STATIC_EXPECTED = {
  'computer.inspect': 'read', 'project.inspect': 'read', 'project.command.inspect': 'read',
  'project.transaction.run': 'destructive', 'file.read': 'read', 'file.list': 'read',
  'file.write': 'write', 'file.create': 'write', 'file.replace': 'destructive',
  'git.status': 'read', 'git.diff': 'read', 'git.rev-parse': 'read',
  'git.checkpoint.inspect': 'read', 'git.checkpoint.create': 'write', 'git.checkpoint.restore': 'destructive',
  'git.write': 'write', 'docker.inspect': 'read', 'docker.manage': 'system',
  'postgres.inspect': 'read', 'postgres.select': 'read', 'vscode.inspect': 'read',
  'vscode.open': 'system', 'terminal.execute': 'destructive', 'browser.inspect': 'read',
  'browser.navigate': 'write', 'browser.interact': 'external', 'browser.tab.focus': 'write',
  'browser.tab.close': 'destructive', 'app.inspect': 'read', 'app.operate': 'external'
} as const;
test('canonical risk registry covers every known static capability exactly', () => {
  const dynamic = { 'project.command.run': 'dynamic' } as const;
  assert.deepEqual(CAPABILITY_RISK_RULES, { ...STATIC_EXPECTED, ...dynamic });
});

class ProbeProvider implements CapabilityProvider {
  readonly name = 'risk-probe';
  executed = false;
  supports(): boolean { return true; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.executed = true;
    return {
      ok: true, capability: action.capability, provider: this.name,
      output: { risk: action.risk }, evidence: [], durationMs: 0
    };
  }
}

for (const [capability, canonicalRisk] of Object.entries(STATIC_EXPECTED)) {
  if (canonicalRisk === 'read') continue;
  test(`${capability} cannot be downgraded to read`, async () => {
    const runtime = new OperatorRuntime();
    const probe = new ProbeProvider();
    runtime.register(probe);
    const result = await runtime.execute({
      id: `downgrade-${capability}`, capability, risk: 'read', input: {},
      provenance: { kind: 'chatgpt' }
    }, { allowedCapabilities: [capability], allowedRoots: [], allowDestructive: true, allowSystemChanges: true, allowExternalWrites: true });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ACTION_RISK_MISMATCH');
    assert.equal(probe.executed, false);
  });
}
test('file.replace mislabeled read is denied before mutation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-risk-'));
  try {
    const file = path.join(dir, 'target.txt');
    await fs.writeFile(file, 'before', 'utf8');
    const expectedSha256 = crypto.createHash('sha256').update('before').digest('hex');
    const runtime = new OperatorRuntime();
    runtime.register(new FilesystemProvider({ allowedRoots: [dir] }));
    const result = await runtime.execute({
      id: 'replace-downgrade', capability: 'file.replace', risk: 'read',
      input: { path: file, content: 'after', expectedSha256 }, provenance: { kind: 'chatgpt' }
    }, {
      allowedCapabilities: ['file.replace'], allowedRoots: [dir],
      allowDestructive: false, allowSystemChanges: false, allowExternalWrites: false
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ACTION_RISK_MISMATCH');
    assert.equal(await fs.readFile(file, 'utf8'), 'before');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file.replace with canonical destructive risk still requires approval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-risk-'));
  try {
    const file = path.join(dir, 'target.txt');
    await fs.writeFile(file, 'before', 'utf8');
    const expectedSha256 = crypto.createHash('sha256').update('before').digest('hex');
    const runtime = new OperatorRuntime().register(new FilesystemProvider({ allowedRoots: [dir] }));
    const result = await runtime.execute({
      id: 'replace-canonical', capability: 'file.replace', risk: 'destructive',
      input: { path: file, content: 'after', expectedSha256 }, provenance: { kind: 'chatgpt' }
    }, {
      allowedCapabilities: ['file.replace'], allowedRoots: [dir],
      allowDestructive: false, allowSystemChanges: false, allowExternalWrites: false
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
    assert.equal(await fs.readFile(file, 'utf8'), 'before');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
