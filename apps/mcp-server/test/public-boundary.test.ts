import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionResult } from '../../../src/core/types.ts';
import type { LocalAgentClient } from '../src/local-agent-client.ts';
import { invokePublicWithAgent } from '../src/public-boundary.ts';
import { PUBLIC_TOOL_NAMES } from '../src/public-tools.ts';
import { assertPublicSafePath, containsRestrictedData } from '../src/restricted-data.ts';

test('public tool surface excludes generic high-power capabilities', () => {
  for (const denied of [
    'terminal.execute', 'browser.inspect', 'browser.navigate', 'browser.interact',
    'app.inspect', 'app.operate', 'postgres.query', 'file.write'
  ]) assert.equal(PUBLIC_TOOL_NAMES.includes(denied), false, denied);
  assert.deepEqual(PUBLIC_TOOL_NAMES, [...PUBLIC_TOOL_NAMES].sort());
});

test('restricted-data guard rejects credential paths and high-confidence secrets', () => {
  assert.throws(() => assertPublicSafePath('C:\\repo\\.env'), /credential or secret-bearing/);
  assert.throws(() => assertPublicSafePath('/home/u/.ssh/id_ed25519'), /credential or secret-bearing/);
  assert.equal(containsRestrictedData({ apiKey: 'secret-value' }), true);
  assert.equal(containsRestrictedData('Authorization: Bearer abcdefghijklmnop'), true);
  assert.equal(containsRestrictedData('ordinary source code with password variable names'), false);
});

test('public result projection strips internal telemetry and absolute path identity', async () => {
  const fakeResult: ActionResult = {
    ok: true,
    capability: 'file.read',
    provider: 'filesystem.native',
    output: {
      path: 'C:\\Users\\Alice\\project\\src\\index.ts',
      content: 'export const value = 1;',
      diagnostics: { hidden: true },
      createdAt: '2026-09-13T00:00:00.000Z'
    },
    evidence: [{ kind: 'file_read', status: 'pass', message: 'ok', timestamp: '2026-09-13T00:00:00.000Z' }],
    durationMs: 123
  };
  const agent = { execute: async () => fakeResult } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.read', 'read', {
    path: 'C:\\Users\\Alice\\project\\src\\index.ts', encoding: 'utf8'
  });
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.provider, undefined);
  assert.equal(structured.durationMs, undefined);
  assert.equal(structured.evidence, undefined);
  assert.equal(structured.output.path, 'src/index.ts');
  assert.equal(structured.output.diagnostics, undefined);
  assert.equal(structured.output.createdAt, undefined);
});

test('restricted-data guard blocks labeled government IDs and PHI-like records', () => {
  assert.equal(containsRestrictedData('SSN: 123-45-6789'), true);
  assert.equal(containsRestrictedData('Aadhaar: 1234 5678 9012'), true);
  assert.equal(containsRestrictedData('passport number: X1234567'), true);
  assert.equal(containsRestrictedData('medical record number: MRN-12345'), true);
  assert.equal(containsRestrictedData('diagnosis: hypertension'), true);
  assert.equal(containsRestrictedData('function diagnosisParser(input) { return input; }'), false);
});

test('public boundary blocks restricted data returned by an agent before it reaches ChatGPT', async () => {
  const agent = { execute: async () => ({
    ok: true,
    capability: 'file.read',
    provider: 'filesystem.native',
    output: { content: 'Authorization: Bearer abcdefghijklmnop' },
    evidence: [],
    durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.read', 'read', { path: 'C:\\repo\\safe.txt', encoding: 'utf8' });
  assert.equal(response.isError, true);
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.error.code, 'RESTRICTED_DATA_BLOCKED');
  assert.equal(JSON.stringify(response).includes('abcdefghijklmnop'), false);
});

test('public write is denied before agent execution when OAuth write scope is absent', async () => {
  let executed = false;
  const agent = { execute: async () => {
    executed = true;
    throw new Error('must not execute');
  } } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.create', 'write', {
    path: 'C:\\repo\\new.ts', content: 'export const value = 1;'
  }, 'C:\\repo\\new.ts', {
    grantedScopes: ['operator:read'], readScope: 'operator:read', writeScope: 'operator:write'
  });
  assert.equal(executed, false);
  assert.equal(response.isError, true);
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.error.code, 'OAUTH_SCOPE_REQUIRED');
});
