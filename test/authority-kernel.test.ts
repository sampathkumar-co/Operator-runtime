import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { AuthorityKernel } from '../src/core/authority-kernel.ts';
import { OperatorRuntime } from '../src/core/runtime.ts';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore, PermissionProfile } from '../src/core/types.ts';

const SCORE: CapabilityScore = {
  reliability: 1,
  latency: 0,
  determinism: 1,
  security: 1,
  reversibility: 1,
  informationQuality: 1,
  interactionCost: 0
};

class ProbeProvider implements CapabilityProvider {
  readonly name = 'authority-probe';
  calls = 0;
  supports(): boolean { return true; }
  score(): CapabilityScore { return SCORE; }
  async execute(action: ActionRequest): Promise<ActionResult> {
    this.calls += 1;
    return {
      ok: true,
      capability: action.capability,
      provider: this.name,
      output: { id: action.id },
      evidence: [],
      durationMs: 0
    };
  }
}

function permissions(root: string): PermissionProfile {
  return {
    allowedCapabilities: ['file.*', 'browser.interact'],
    allowedRoots: [root],
    allowExternalWrites: true,
    allowSystemChanges: false,
    allowDestructive: false
  };
}

test('authority tokens can only attenuate parent capability and path scope', () => {
  const root = path.resolve('/tmp/operator-authority');
  const kernel = new AuthorityKernel({ secret: Buffer.alloc(32, 7) });
  assert.doesNotThrow(() => kernel.issueToken(permissions(root), {
    capability: 'file.read',
    roots: [path.join(root, 'src')],
    maxRisk: 'read'
  }));
  assert.throws(() => kernel.issueToken(permissions(root), {
    capability: 'terminal.execute'
  }), (error: any) => error?.code === 'AUTHORITY_CAPABILITY_ESCALATION');
  assert.throws(() => kernel.issueToken(permissions(root), {
    capability: 'file.read',
    roots: [path.resolve(root, '..', 'outside')]
  }), (error: any) => error?.code === 'AUTHORITY_SCOPE_ESCALATION');
});

test('runtime enforces action-bound capability token before provider execution', async () => {
  const root = path.resolve('/tmp/operator-authority');
  const authority = new AuthorityKernel({ secret: Buffer.alloc(32, 9) });
  const runtime = new OperatorRuntime({ authority });
  const provider = new ProbeProvider();
  runtime.register(provider);
  const token = authority.issueToken(permissions(root), {
    capability: 'file.read',
    roots: [root],
    maxRisk: 'read',
    actionIds: ['read-allowed']
  });

  const allowed = await runtime.execute({
    id: 'read-allowed',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, permissions(root), { authorityToken: token });
  assert.equal(allowed.ok, true);
  assert.equal(provider.calls, 1);

  const denied = await runtime.execute({
    id: 'read-other',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, permissions(root), { authorityToken: token });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'AUTHORITY_TOKEN_ACTION_MISMATCH');
  assert.equal(provider.calls, 1);
});

test('authority token integrity, expiry, scope and risk ceilings fail closed', async () => {
  const root = path.resolve('/tmp/operator-authority');
  let now = new Date('2026-09-28T00:00:00.000Z');
  const authority = new AuthorityKernel({
    secret: Buffer.alloc(32, 11),
    clock: () => now
  });
  const runtime = new OperatorRuntime({ authority });
  const provider = new ProbeProvider();
  runtime.register(provider);
  const profile = permissions(root);

  const token = authority.issueToken(profile, {
    capability: 'file.read',
    roots: [path.join(root, 'safe')],
    maxRisk: 'read',
    ttlMs: 1_000
  });
  const outOfScope = await runtime.execute({
    id: 'scope-mismatch',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'other', 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, profile, { authorityToken: token });
  assert.equal(outOfScope.error?.code, 'AUTHORITY_TOKEN_SCOPE_MISMATCH');

  const tampered = structuredClone(token);
  tampered.claims.roots = [root];
  const tamperResult = await runtime.execute({
    id: 'tamper',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'safe', 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, profile, { authorityToken: tampered });
  assert.equal(tamperResult.error?.code, 'AUTHORITY_TOKEN_TAMPERED');

  now = new Date(now.getTime() + 1_001);
  const expired = await runtime.execute({
    id: 'expired',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'safe', 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, profile, { authorityToken: token });
  assert.equal(expired.error?.code, 'AUTHORITY_TOKEN_EXPIRED');

  now = new Date('2026-09-28T00:00:00.000Z');
  const lowRiskToken = authority.issueToken(profile, {
    capability: 'browser.interact',
    maxRisk: 'write'
  });
  const riskDenied = await runtime.execute({
    id: 'external-risk',
    capability: 'browser.interact',
    risk: 'external',
    input: {},
    provenance: { kind: 'chatgpt' }
  }, profile, { authorityToken: lowRiskToken });
  assert.equal(riskDenied.error?.code, 'AUTHORITY_TOKEN_RISK_EXCEEDED');
  assert.equal(provider.calls, 0);
});


test('capability tokens inherit parent maxRisk and cannot widen it', () => {
  const root = path.resolve('/tmp/operator-authority-risk-ceiling');
  const kernel = new AuthorityKernel({ secret: Buffer.alloc(32, 19) });
  const profile: PermissionProfile = {
    allowedCapabilities: ['file.*'],
    allowedRoots: [root],
    maxRisk: 'read',
    allowDestructive: true
  };

  const inherited = kernel.issueToken(profile, { capability: 'file.read' });
  assert.equal(inherited.claims.maxRisk, 'read');

  assert.throws(
    () => kernel.issueToken(profile, { capability: 'file.read', maxRisk: 'destructive' }),
    (error: any) => error?.code === 'AUTHORITY_RISK_ESCALATION'
  );
});

test('capability token root attenuation covers every path operand in a multi-path action', () => {
  const root = path.resolve('/tmp/operator-authority-multi');
  const safe = path.join(root, 'safe');
  const outsideToken = path.join(root, 'other');
  const authority = new AuthorityKernel({ secret: Buffer.alloc(32, 23) });
  const profile = permissions(root);
  const token = authority.issueToken(profile, {
    capability: 'file.manage',
    roots: [safe],
    maxRisk: 'write'
  });
  const action: ActionRequest = {
    id: 'multi-path-token',
    capability: 'file.manage',
    risk: 'write',
    input: {
      operation: 'move',
      path: path.join(safe, 'decoy.txt'),
      source: path.join(safe, 'source.txt'),
      destination: path.join(outsideToken, 'destination.txt')
    },
    provenance: { kind: 'chatgpt' }
  };
  assert.throws(
    () => authority.verifyToken(token, action, profile),
    (error: any) => error?.code === 'AUTHORITY_TOKEN_SCOPE_MISMATCH'
  );
});

test('runtime revalidates token expiry immediately before provider dispatch', async () => {
  const root = path.resolve('/tmp/operator-authority-dispatch-expiry');
  let now = new Date('2026-10-04T00:00:00.000Z');
  const authority = new AuthorityKernel({ secret: Buffer.alloc(32, 29), clock: () => now });
  let calls = 0;
  const provider: CapabilityProvider = {
    name: 'expiry-probe',
    supports: () => true,
    score: () => {
      now = new Date('2026-10-04T00:00:02.000Z');
      return SCORE;
    },
    execute: async (action) => {
      calls += 1;
      return { ok: true, capability: action.capability, provider: 'expiry-probe', evidence: [], durationMs: 0 };
    }
  };
  const runtime = new OperatorRuntime({ authority }).register(provider);
  const profile = permissions(root);
  const token = authority.issueToken(profile, {
    capability: 'file.read',
    roots: [root],
    maxRisk: 'read',
    ttlMs: 1_000
  });
  let dispatched = false;
  const result = await runtime.execute({
    id: 'expires-during-ranking',
    capability: 'file.read',
    risk: 'read',
    input: { path: path.join(root, 'a.txt') },
    provenance: { kind: 'chatgpt' }
  }, profile, {
    authorityToken: token,
    onProviderDispatch: () => { dispatched = true; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'AUTHORITY_TOKEN_EXPIRED');
  assert.equal(result.error?.executionPhase, 'pre_dispatch');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(dispatched, false);
  assert.equal(calls, 0);
});

test('runtime revalidates selected-provider dynamic risk immediately before dispatch', async () => {
  const root = path.resolve('/tmp/operator-authority-risk-drift');
  const authority = new AuthorityKernel({ secret: Buffer.alloc(32, 31) });
  let risk: 'write' | 'destructive' = 'write';
  let calls = 0;
  const provider: CapabilityProvider = {
    name: 'risk-drift-probe',
    supports: () => true,
    resolveRisk: () => risk,
    score: () => {
      risk = 'destructive';
      return SCORE;
    },
    execute: async (action) => {
      calls += 1;
      return { ok: true, capability: action.capability, provider: 'risk-drift-probe', evidence: [], durationMs: 0 };
    }
  };
  const runtime = new OperatorRuntime({ authority }).register(provider);
  let dispatched = false;
  const result = await runtime.execute({
    id: 'risk-drift',
    capability: 'file.manage',
    risk: 'write',
    input: { operation: 'copy', source: path.join(root, 'a.txt'), destination: path.join(root, 'b.txt') },
    provenance: { kind: 'chatgpt' }
  }, permissions(root), {
    onProviderDispatch: () => { dispatched = true; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'ACTION_RISK_MISMATCH');
  assert.equal(result.error?.executionPhase, 'pre_dispatch');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(dispatched, false);
  assert.equal(calls, 0);
});
