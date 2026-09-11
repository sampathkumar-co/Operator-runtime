import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CERTIFIED_TUNNEL_CLIENT,
  assertDoctorOutputSecretSafe,
  buildTunnelChildEnv,
  buildTunnelDoctorArgs,
  parseDoctorSummary,
  readTunnelCredentialStatus,
  validateTunnelClientVersion
} from '../scripts/secure-tunnel-preflight.ts';

test('secure tunnel credential status is presence-only and validates tunnel ids', () => {
  assert.deepEqual(readTunnelCredentialStatus({}), {
    tunnelId: null,
    hasRuntimeApiKey: false,
    missing: ['CONTROL_PLANE_TUNNEL_ID', 'CONTROL_PLANE_API_KEY']
  });

  assert.deepEqual(readTunnelCredentialStatus({
    CONTROL_PLANE_TUNNEL_ID: 'tunnel_0123456789abcdef0123456789abcdef',
    CONTROL_PLANE_API_KEY: 'fake-runtime-key-never-returned'
  }), {
    tunnelId: 'tunnel_0123456789abcdef0123456789abcdef',
    hasRuntimeApiKey: true,
    missing: []
  });

  assert.throws(
    () => readTunnelCredentialStatus({ CONTROL_PLANE_TUNNEL_ID: 'tunnel_ABC' }),
    /32 lowercase hex/
  );
});

test('doctor args reference the runtime key by environment name and never embed it', () => {
  const args = buildTunnelDoctorArgs(
    new URL('http://127.0.0.1:47200/mcp'),
    'tunnel_0123456789abcdef0123456789abcdef'
  );
  assert.deepEqual(args, [
    'doctor',
    '--mcp.server-url', 'url=http://127.0.0.1:47200/mcp',
    '--health.listen-addr', '127.0.0.1:0',
    '--control-plane.tunnel-id', 'tunnel_0123456789abcdef0123456789abcdef',
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--json',
    '--explain'
  ]);
  assert.equal(JSON.stringify(args).includes('fake-runtime-key'), false);
});

test('certification pins the exact reviewed OpenAI tunnel-client release for Windows x64', () => {
  assert.equal(CERTIFIED_TUNNEL_CLIENT.version, '0.0.14');
  assert.equal(CERTIFIED_TUNNEL_CLIENT.archiveSha256, '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5');
  assert.equal(CERTIFIED_TUNNEL_CLIENT.executableSha256, 'fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b');
  validateTunnelClientVersion('0.0.14+0f870e50a973fa820d4c409000059e181e8d242b (git sha: 0f870e50a973fa820d4c409000059e181e8d242b)', 'win32', 'x64');
  assert.throws(() => validateTunnelClientVersion('0.0.15+future', 'win32', 'x64'), /requires tunnel-client 0.0.14/);
  assert.throws(() => validateTunnelClientVersion('0.0.14+same', 'linux', 'x64'), /currently pins win32\/x64/);
});

test('doctor evidence is secret-safe and reduced to bounded fields', () => {
  const secret = 'fake-runtime-key-never-log-this';
  assert.doesNotThrow(() => assertDoctorOutputSecretSafe('{"result":"pass"}', '', secret));
  assert.throws(() => assertDoctorOutputSecretSafe(`prefix ${secret} suffix`, '', secret), /contained the runtime API key/);
  assert.throws(() => assertDoctorOutputSecretSafe('', `oops ${secret}`, secret), /contained the runtime API key/);

  assert.deepEqual(parseDoctorSummary(JSON.stringify({
    result: 'pass',
    failed_checks: [],
    checks: [{ id: 'mcp', status: 'PASS', summary: 'reachable', evidence: ['verbose'], next: ['ignored'] }],
    unrelated: 'ignored'
  })), {
    result: 'pass',
    failedChecks: [],
    checks: [{ id: 'mcp', status: 'PASS', summary: 'reachable' }]
  });
});

test('tunnel child environment excludes unrelated parent credentials', () => {
  const parent = {
    PATH: 'C:\Windows\System32',
    TEMP: 'C:\Temp',
    HTTPS_PROXY: 'http://proxy.example:8080',
    CONTROL_PLANE_API_KEY: 'sk-runtime-only',
    GITHUB_TOKEN: 'gh-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret'
  };
  assert.deepEqual(buildTunnelChildEnv(parent, false), {
    PATH: 'C:\Windows\System32',
    TEMP: 'C:\Temp',
    HTTPS_PROXY: 'http://proxy.example:8080'
  });
  assert.deepEqual(buildTunnelChildEnv(parent, true), {
    PATH: 'C:\Windows\System32',
    TEMP: 'C:\Temp',
    HTTPS_PROXY: 'http://proxy.example:8080',
    CONTROL_PLANE_API_KEY: 'sk-runtime-only'
  });
});
