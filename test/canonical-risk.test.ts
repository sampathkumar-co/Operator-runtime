import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FilesystemProvider } from '../src/capabilities/filesystem.ts';
import { CAPABILITY_RISK_RULES, capabilityRiskRule, isBuiltInCapability, registerExtensionCapabilityRisk } from '../src/core/capability-policy.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1, latency: 0, determinism: 1, security: 1,
  reversibility: 1, informationQuality: 1, interactionCost: 0
};

const STATIC_EXPECTED = {
  'computer.inspect': 'read', 'project.inspect': 'read', 'project.command.inspect': 'read',
  'project.transaction.run': 'destructive', 'workspace.edit.transaction': 'write', 'workspace.edit.rollback': 'destructive', 'workspace.edit.resolve_lsp': 'read', 'file.read': 'read', 'file.list': 'read',
  'file.write': 'write', 'file.create': 'write', 'file.replace': 'destructive', 'file.info': 'read', 'file.search': 'read',
  'git.status': 'read', 'git.diff': 'read', 'git.rev-parse': 'read',
  'git.checkpoint.inspect': 'read', 'git.checkpoint.create': 'write', 'git.checkpoint.restore': 'destructive',
  'git.write': 'write', 'docker.inspect': 'read', 'docker.manage': 'system', 'compute.run': 'write',
  'postgres.inspect': 'read', 'postgres.select': 'read', 'vscode.inspect': 'read',
  'vscode.open': 'system', 'terminal.execute': 'destructive', 'process.inspect': 'read', 'process.manage': 'destructive', 'browser.inspect': 'read',
  'browser.verify': 'read', 'browser.navigate': 'write', 'browser.interact': 'external', 'browser.tab.focus': 'write',
  'browser.tab.close': 'destructive', 'app.inspect': 'read', 'app.operate': 'external',
  'visual.capture': 'read', 'input.operate': 'external', 'perception.observe': 'write', 'perception.ground': 'read',
  'document.inspect': 'read', 'document.extract': 'read', 'document.render': 'read',
  'structured.inspect': 'read', 'structured.extract': 'read', 'structured.render': 'read'
} as const;
test('canonical risk registry covers every known static capability exactly', () => {
  const dynamic = { 'project.command.run': 'dynamic', 'file.manage': 'dynamic', 'terminal.session': 'dynamic' } as const;
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

test('prototype-chain names are not implicitly registered capability risk rules', () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(isBuiltInCapability(key), false, key);
    assert.throws(
      () => capabilityRiskRule(key),
      (error: any) => error?.code === 'CAPABILITY_RISK_UNREGISTERED',
      key
    );
  }
  assert.equal(capabilityRiskRule('file.read'), 'read');
  assert.equal(capabilityRiskRule('browser.interact'), 'external');
});


test('C02 extension capability risk registration requires literal namespace and owner identities', () => {
  const extensionId = 'reviewed_ext';
  const owner = 'a'.repeat(64);
  const capability = 'ext.reviewed_ext.read_file';
  let conversions = 0;
  const impersonator = {
    toString() { conversions++; return extensionId; },
    valueOf() { conversions++; return extensionId; }
  };
  const attempts: Array<[Record<string, unknown>, string]> = [
    [{ capability: impersonator, extensionId, owner, rule: 'read' }, 'CAPABILITY_EXTENSION_NAMESPACE_INVALID'],
    [{ capability, extensionId: impersonator, owner, rule: 'read' }, 'CAPABILITY_EXTENSION_NAMESPACE_INVALID'],
    [{ capability, extensionId, owner: impersonator, rule: 'read' }, 'CAPABILITY_EXTENSION_OWNER_INVALID'],
    [{ capability: [capability], extensionId, owner, rule: 'read' }, 'CAPABILITY_EXTENSION_NAMESPACE_INVALID'],
    [{ capability, extensionId, owner: [owner], rule: 'read' }, 'CAPABILITY_EXTENSION_OWNER_INVALID'],
    [{ capability, extensionId, owner, rule: ['read'] }, 'CAPABILITY_EXTENSION_RISK_INVALID']
  ];
  for (const [input, code] of attempts) {
    assert.throws(() => registerExtensionCapabilityRisk(input as any),
      (error: any) => error?.code === code, code);
  }
  assert.equal(conversions, 0, 'extension registration must never invoke caller conversions');
  assert.throws(() => capabilityRiskRule(impersonator as any),
    (error: any) => error?.code === 'CAPABILITY_RISK_UNREGISTERED');
  assert.equal(conversions, 0, 'lookup must not coerce untrusted names');
  assert.throws(() => capabilityRiskRule(capability),
    (error: any) => error?.code === 'CAPABILITY_RISK_UNREGISTERED');

  const releaseOne = registerExtensionCapabilityRisk({
    capability, extensionId, owner, rule: 'read'
  });
  const releaseTwo = registerExtensionCapabilityRisk({
    capability, extensionId, owner, rule: 'read'
  });
  try {
    assert.equal(capabilityRiskRule(capability), 'read', 'literal registration is still authorized');
    releaseOne();
    assert.equal(capabilityRiskRule(capability), 'read', 'remaining lease retains the same scoped rule');
  } finally {
    releaseTwo();
    releaseOne();
  }
  assert.throws(() => capabilityRiskRule(capability),
    (error: any) => error?.code === 'CAPABILITY_RISK_UNREGISTERED',
    'no risk registration survives the final owner lease release');
});
