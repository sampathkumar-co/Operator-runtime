import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import type { ActionResult } from '../../../src/core/types.ts';
import type { LocalAgentClient } from '../src/local-agent-client.ts';
import { invokePublicWithAgent } from '../src/public-boundary.ts';
import { PUBLIC_TOOL_NAMES, registerPublicTools } from '../src/public-tools.ts';
import { assertPublicSafePath, containsRestrictedData } from '../src/restricted-data.ts';

test('public tool surface excludes generic high-power capabilities', () => {
  for (const denied of [
    'device.claim', 'terminal.execute', 'browser.inspect', 'browser.navigate', 'browser.interact',
    'app.inspect', 'app.operate', 'postgres.query', 'file.write'
  ]) assert.equal(PUBLIC_TOOL_NAMES.includes(denied), false, denied);
  assert.deepEqual(PUBLIC_TOOL_NAMES, [...PUBLIC_TOOL_NAMES].sort());
});

test('public tools/list advertises exact OAuth scopes at top level and compatibility metadata', async (t) => {
  const server = new McpServer({ name: 'oauth-wire-test', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerPublicTools(server, async () => { throw new Error('not called'); }, {
    readScope: 'operator:read', writeScope: 'operator:write'
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: any[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    sent.push(structuredClone(message));
    await originalSend(message, options);
  };
  const client = new Client({ name: 'oauth-wire-client', version: '0.1.0' });
  t.after(async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...PUBLIC_TOOL_NAMES].sort());
  const response = sent.find((message) => Array.isArray(message?.result?.tools));
  assert.ok(response, 'raw tools/list response was not observed');
  for (const tool of response.result.tools as Array<Record<string, any>>) {
    const scopes = ['file.create', 'file.replace'].includes(String(tool.name))
      ? ['operator:read', 'operator:write'] : ['operator:read'];
    const expected = [{ type: 'oauth2', scopes }];
    assert.deepEqual(tool.securitySchemes, expected, `${tool.name} top-level securitySchemes`);
    assert.deepEqual(tool._meta?.securitySchemes, expected, `${tool.name} compatibility securitySchemes`);
  }
});

test('restricted-data guard rejects credential paths and high-confidence secrets', () => {
  assert.throws(() => assertPublicSafePath('C:\\repo\\.env'), /credential or secret-bearing/);
  assert.throws(() => assertPublicSafePath('/home/u/.ssh/id_ed25519'), /credential or secret-bearing/);
  assert.equal(containsRestrictedData({ apiKey: 'secret-value' }), true);
  assert.equal(containsRestrictedData('Authorization: Bearer abcdefghijklmnop'), true);
  assert.equal(containsRestrictedData('DATABASE_URL=postgres://user:secret@db.example/app'), true);
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
  assert.equal(structured.output.path, '[path]/index.ts');
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

test('public write returns OAuth step-up challenge before execution and succeeds with write scope', async () => {
  let executions = 0;
  const agent = { execute: async () => {
    executions += 1;
    return {
      ok: true, capability: 'file.create', provider: 'test-provider',
      output: { created: true }, evidence: [], durationMs: 1
    } as ActionResult;
  } } as unknown as LocalAgentClient;
  const input = { path: 'C:\\repo\\new.ts', content: 'export const value = 1;' };
  const auth = {
    readScope: 'operator:read', writeScope: 'operator:write',
    resourceMetadataUrl: 'https://edge.operator-runtime.dev/.well-known/oauth-protected-resource/mcp'
  };
  const denied = await invokePublicWithAgent(agent, 'file.create', 'write', input, input.path, {
    ...auth, grantedScopes: ['operator:read']
  });
  assert.equal(executions, 0);
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as Record<string, any>).error.code, 'OAUTH_SCOPE_REQUIRED');
  const challenges = (denied as any)._meta?.['mcp/www_authenticate'];
  assert.ok(Array.isArray(challenges) && challenges.length === 1);
  assert.match(challenges[0], /error="insufficient_scope"/);
  assert.match(challenges[0], /scope="operator:read operator:write"/);
  assert.match(challenges[0], /oauth-protected-resource\/mcp/);
  assert.equal(JSON.stringify(denied).includes('new.ts'), false);
  const allowed = await invokePublicWithAgent(agent, 'file.create', 'write', input, input.path, {
    ...auth, grantedScopes: ['operator:read', 'operator:write']
  });
  assert.equal(executions, 1);
  assert.equal(allowed.isError, false);
  assert.equal((allowed.structuredContent as Record<string, any>).output.created, true);
});

test('public Git diff rejects sensitive nested path entries before agent execution', async () => {
  let executed = false;
  const agent = { execute: async () => {
    executed = true;
    throw new Error('must not execute');
  } } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'git.diff', 'read', {
    cwd: 'C:\\repo', paths: ['.env'], publicLiteralFiles: true
  });
  assert.equal(executed, false);
  assert.equal(response.isError, true);
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.error.code, 'RESTRICTED_DATA_PATH_DENIED');
});

test('public git.diff rejects traversal, drive-relative, UNC, and glob filters before dispatch', async (t) => {
  let executions = 0;
  const server = new McpServer({ name: 'git-filter-boundary-test', version: '0.1.0' }, { capabilities: { tools: {} } });
  registerPublicTools(server, async () => {
    executions += 1;
    throw new Error('invalid filters must not dispatch');
  }, { readScope: 'operator:read', writeScope: 'operator:write' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'git-filter-boundary-client', version: '0.1.0' });
  t.after(async () => { await client.close().catch(() => {}); await server.close().catch(() => {}); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  for (const filter of ['../outside.txt', 'src/../outside.txt', '..\\outside.txt', 'C:outside.txt', '\\\\server\\share\\outside.txt', '*.ts']) {
    const result = await client.callTool({ name: 'git.diff', arguments: { cwd: 'C:\\repo', paths: [filter] } });
    assert.equal(result.isError, true, filter);
    const structured = result.structuredContent as Record<string, any>;
    assert.equal(structured.error.code, 'PUBLIC_PATH_FILTER_INVALID', filter);
  }
  assert.equal(executions, 0);
});


test('public result sanitizer redacts nested absolute paths and internal identifiers by value', async () => {
  const fakeResult: ActionResult = {
    ok: true,
    capability: 'file.read',
    provider: 'test-provider',
    output: {
      summary: 'Failed reading C:\\Users\\Alice\\private\\token.txt during inspection',
      nested: [
        { note: 'cache at /home/alice/.operator/state/accounts/a.json' },
        { detail: 'requestId=req-123' }
      ],
      requestId: 'internal-request-123',
      safeSha256: 'a'.repeat(64)
    },
    evidence: [],
    durationMs: 2
  };
  const agent = { execute: async () => fakeResult } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.read', 'read', { path: 'C:\\repo' });
  const json = JSON.stringify(response);
  assert.equal(json.includes('C:\\\\Users\\\\Alice'), false);
  assert.equal(json.includes('/home/alice'), false);
  assert.equal(json.includes('req-123'), false);
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.output.requestId, undefined);
  assert.equal(structured.output.safeSha256, 'a'.repeat(64));
});


test('public errors never expose raw internal exception messages or unknown internal codes', async () => {
  const agent = { execute: async () => ({
    ok: false,
    capability: 'file.read',
    provider: 'filesystem.native',
    evidence: [],
    durationMs: 1,
    error: {
      code: 'INTERNAL_SQLITE_CORRUPTION',
      message: 'Failed reading C:\\Users\\Alice\\private\\token.txt requestId=req-123',
      retryable: false
    }
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.read', 'read', { path: 'C:\\repo\\safe.txt' });
  const json = JSON.stringify(response);
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(structured.error.code, 'PUBLIC_REQUEST_FAILED');
  assert.equal(structured.error.message, 'The request could not be completed safely.');
  assert.equal(json.includes('INTERNAL_SQLITE_CORRUPTION'), false);
  assert.equal(json.includes('Alice'), false);
  assert.equal(json.includes('req-123'), false);
});

test('thrown non-Operator errors are mapped without reflecting exception text', async () => {
  const agent = { execute: async () => {
    throw new Error('open /home/alice/.operator/private-state.json failed');
  } } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.read', 'read', { path: 'C:\\repo' });
  assert.equal(response.isError, true);
  const json = JSON.stringify(response);
  assert.equal(json.includes('/home/alice'), false);
  assert.equal(json.includes('private-state.json'), false);
  assert.equal((response.structuredContent as Record<string, any>).error.code, 'PUBLIC_BOUNDARY_REJECTED');
});

test('public computer inspect exposes only coarse platform identity', async () => {
  const agent = { execute: async () => ({
    ok: true, capability: 'computer.inspect', provider: 'system.native',
    output: {
      hostname: 'HOST-SECRET', platform: 'win32', release: '10.0.26100', arch: 'x64',
      cpuCount: 16, totalMemoryBytes: 34359738368, node: 'v22.19.0'
    }, evidence: [], durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'computer.inspect', 'read', {});
  assert.deepEqual((response.structuredContent as any).output, {
    platformFamily: 'windows', architecture: 'x64'
  });
  const json = JSON.stringify(response);
  assert.equal(json.includes('HOST-SECRET'), false);
  assert.equal(json.includes('26100'), false);
  assert.equal(json.includes('34359738368'), false);
  assert.equal(json.includes('v22.19.0'), false);
});

test('public project inspect returns script names but never package script bodies', async () => {
  const agent = { execute: async () => ({
    ok: true, capability: 'project.inspect', provider: 'project.semantic',
    output: {
      root: 'C:\\Users\\Alice\\repo', repository: true,
      buildSystems: ['node'], packageManager: 'npm',
      scripts: { build: 'node build.js --token super-secret-value', test: 'node --test' },
      manifests: ['package.json'], pyprojectDetected: false,
      observedAt: '2026-09-14T00:00:00.000Z'
    }, evidence: [], durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'project.inspect', 'read', { path: 'C:\\repo' });
  const output = (response.structuredContent as any).output;
  assert.deepEqual(output.scriptNames, ['build', 'test']);
  assert.equal(output.root, undefined);
  const json = JSON.stringify(response);
  assert.equal(json.includes('build.js'), false);
  assert.equal(json.includes('super-secret-value'), false);
  assert.equal(json.includes('Alice'), false);
});

test('public project commands expose semantic metadata without executable authority details', async () => {
  const agent = { execute: async () => ({
    ok: true, capability: 'project.command.inspect', provider: 'project.command.trusted',
    output: {
      projectRoot: 'C:\\Users\\Alice\\repo', registryConfigured: true, registryLocation: 'operator-local-config',
      commands: [{
        id: 'build', title: 'Build app', kind: 'build', executable: 'node.exe',
        args: ['build.js', '--token', 'super-secret-value'], cwd: 'tools', timeoutMs: 60000, risk: 'write',
        artifacts: [{ path: 'dist/private.json', kind: 'json', minBytes: 1, mustChange: true }]
      }]
    }, evidence: [], durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'project.command.inspect', 'read', { path: 'C:\\repo' });
  const output = (response.structuredContent as any).output;
  assert.equal(output.setupRequired, false);
  const command = output.commands[0];
  assert.deepEqual(command, {
    id: 'build', title: 'Build app', kind: 'build', risk: 'write',
    expectedOutput: { artifactCount: 1, kinds: ['json'], requiresChange: true }
  });
  const json = JSON.stringify(response);
  for (const forbidden of ['node.exe', '--token', 'super-secret-value', 'dist/private.json', 'Alice']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test('public project commands explain safe local setup when the trusted registry is absent', async () => {
  const agent = { execute: async () => ({
    ok: true, capability: 'project.command.inspect', provider: 'project.command.trusted',
    output: { projectRoot: 'C:\\repo', registryConfigured: false, registryLocation: 'operator-local-config', commands: [] },
    evidence: [], durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'project.command.inspect', 'read', { path: 'C:\\repo' });
  const output = (response.structuredContent as any).output;
  assert.equal(output.registryConfigured, false);
  assert.equal(output.setupRequired, true);
  assert.match(output.setupHint, /Configure trusted commands locally/);
  assert.deepEqual(output.commands, []);
  assert.equal(JSON.stringify(output).includes('registryLocation'), false);
});

test('public file list filters sensitive entry names instead of failing the whole directory', async () => {
  const agent = { execute: async () => ({
    ok: true, capability: 'file.list', provider: 'filesystem.native',
    output: {
      path: 'C:\\Users\\Alice\\repo',
      entries: [
        { name: '.env', type: 'file' }, { name: '.ssh', type: 'directory' },
        { name: 'credentials.json', type: 'file' }, { name: 'src', type: 'directory' },
        { name: 'safe.ts', type: 'file' }
      ], truncated: false
    }, evidence: [], durationMs: 1
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.list', 'read', { path: 'C:\\repo' });
  assert.equal(response.isError, false);
  const output = (response.structuredContent as any).output;
  assert.deepEqual(output.entries, [
    { name: 'src', type: 'directory' }, { name: 'safe.ts', type: 'file' }
  ]);
  assert.equal(output.path, undefined);
  const json = JSON.stringify(response);
  assert.equal(json.includes('.env'), false);
  assert.equal(json.includes('.ssh'), false);
  assert.equal(json.includes('credentials.json'), false);
  assert.equal(json.includes('Alice'), false);
});


test('public relay liveness errors keep only safe code, message, and retryability', async () => {
  const agent = { execute: async () => ({
    ok: false,
    capability: 'file.create',
    provider: 'relay.control',
    evidence: [],
    durationMs: 1,
    error: {
      code: 'ROUTE_DEVICE_OFFLINE',
      message: 'deviceId=private-device-id internal route details',
      retryable: true
    }
  }) } as unknown as LocalAgentClient;
  const response = await invokePublicWithAgent(agent, 'file.create', 'write', {
    path: 'C:\\repo\\safe.txt',
    content: 'safe'
  });
  const structured = response.structuredContent as Record<string, any>;
  assert.equal(response.isError, true);
  assert.equal(structured.error.code, 'ROUTE_DEVICE_OFFLINE');
  assert.equal(structured.error.message, 'The paired device is currently offline or stale.');
  assert.equal(structured.error.retryable, true);
  assert.equal(JSON.stringify(response).includes('private-device-id'), false);
});

test('public boundary preserves safe operational error codes without leaking internal messages', async () => {
  const cases = [
    ['ROUTE_AMBIGUOUS', 'More than one paired device is online. Stop the unintended runtime or select a device before retrying.'],
    ['WINDOWS_PATH_LEASE_HELPER_REQUIRED', 'The Windows path authority helper is unavailable.'],
    ['WINDOWS_PATH_LEASE_TIMEOUT', 'Windows path authority validation timed out.'],
    ['CAPABILITY_UNAVAILABLE', 'The requested capability is not currently available on the paired device.'],
    ['RELAY_DELIVERY_CAPABILITY_RETIRED', 'The routed action was retired because the active device no longer advertised the required capability.']
  ] as const;

  for (const [code, message] of cases) {
    const agent = { execute: async () => ({
      ok: false,
      capability: 'file.read',
      provider: 'internal-provider',
      evidence: [],
      durationMs: 1,
      error: { code, message: 'private deviceId=secret-device C:\\Users\\Alice\\private.txt', retryable: true }
    }) } as unknown as LocalAgentClient;
    const response = await invokePublicWithAgent(agent, 'file.read', 'read', { path: 'C:\\repo\\safe.txt' });
    const structured = response.structuredContent as Record<string, any>;
    assert.equal(structured.error.code, code);
    assert.equal(structured.error.message, message);
    assert.equal(structured.error.retryable, true);
    const json = JSON.stringify(response);
    assert.equal(json.includes('secret-device'), false);
    assert.equal(json.includes('Alice'), false);
  }
});
