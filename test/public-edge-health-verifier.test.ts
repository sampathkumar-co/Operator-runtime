import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('deploy/public-edge/verify-live-relay-gateway.sh');
const expectedCommit = '882a3989cd636af62a220dfdc3d3a3cb85ebb02f';
const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : '/bin/sh';

test('live gateway verifier uses a POSIX shell, Docker-hosted JSON parser and bounded unauthenticated authority probe', async () => {
  const source = await fs.readFile(script, 'utf8');
  assert.match(source, /^#!\/bin\/sh/m);
  assert.match(source, /docker exec -i "\$container" node -e/);
  assert.match(source, /sourceCommit !== expected/);
  assert.match(source, /device-authority\/check/);
  assert.match(source, /"\$authority_status" != 401/);
  assert.doesNotMatch(source, /StrictHostKeyChecking=no|curl.+--insecure/);
  const check = spawnSync(shell, ['-n', script], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const missing = spawnSync(shell, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 64, missing.stderr);
});

test('live gateway verifier validates health JSON/source and rejects missing authority route', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-live-gateway-verifier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const mockCurl = `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; output=$1;;
  esac
  shift
done
if [ "$output" = /dev/null ]; then
  printf '%s' "$MOCK_AUTH_STATUS"
else
  printf '%s' "$MOCK_HEALTH_JSON" > "$output"
fi
`;
  const mockDocker = `#!/bin/sh
[ "$1" = exec ] || exit 30
shift
[ "$1" = -i ] || exit 31
shift
shift
[ "$1" = node ] || exit 32
shift
exec node "$@"
`;
  await Promise.all([
    fs.writeFile(path.join(bin, 'curl'), mockCurl, { mode: 0o755 }),
    fs.writeFile(path.join(bin, 'docker'), mockDocker, { mode: 0o755 })
  ]);

  const healthy = JSON.stringify({
    ok: true,
    service: 'mecord-connect',
    sourceCommit: expectedCommit
  });
  const run = (response: string, status = '401') => spawnSync(shell, [script, 'test-operator-edge', expectedCommit], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      MOCK_HEALTH_JSON: response,
      MOCK_AUTH_STATUS: status
    }
  });

  const accepted = run(healthy);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /verification passed/);
  const stale = run(JSON.stringify({ ok: true, service: 'mecord-connect', sourceCommit: 'a'.repeat(40) }));
  assert.notEqual(stale.status, 0);
  const invalid = run('not-json');
  assert.notEqual(invalid.status, 0);
  const noRoute = run(healthy, '404');
  assert.notEqual(noRoute.status, 0);
  assert.match(noRoute.stderr, /Authority route mismatch/);
});
