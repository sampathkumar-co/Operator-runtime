import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIC_PLUGIN_CAPABILITIES } from '../src/core/public-plugin-surface.ts';
import { DEVELOPER_RELAY_CAPABILITIES } from '../src/core/developer-relay-surface.ts';
import { developerAccountIds as resultDeveloperAccountIds, relaySessionScopesForAccount as resultRelaySessionScopesForAccount } from '../apps/relay-server/src/result-service.ts';
import { developerAccountIds, relaySessionScopesForAccount } from '../src/core/developer-relay-surface.ts';

const developer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const normal = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('relay session scopes remain public-only unless account is explicitly developer-entitled', () => {
  const publicScopes = relaySessionScopesForAccount(normal, { OPERATOR_DEVELOPER_ACCOUNT_IDS: developer } as NodeJS.ProcessEnv);
  assert.equal(publicScopes.includes('relay:developer'), false);
  assert.deepEqual(
    publicScopes.filter((scope) => scope.startsWith('cap:')).sort(),
    PUBLIC_PLUGIN_CAPABILITIES.map((capability) => `cap:${capability}`).sort()
  );

  const developerScopes = relaySessionScopesForAccount(developer, { OPERATOR_DEVELOPER_ACCOUNT_IDS: developer } as NodeJS.ProcessEnv);
  assert.equal(developerScopes.includes('relay:developer'), true);
  assert.deepEqual(
    developerScopes.filter((scope) => scope.startsWith('cap:')).sort(),
    DEVELOPER_RELAY_CAPABILITIES.map((capability) => `cap:${capability}`).sort()
  );
  for (const capability of PUBLIC_PLUGIN_CAPABILITIES) {
    assert.equal(developerScopes.includes(`cap:${capability}`), true);
  }
});

test('result-service and centralized entitlement policy stay identical', () => {
  const env = { OPERATOR_DEVELOPER_ACCOUNT_IDS: developer } as NodeJS.ProcessEnv;
  assert.deepEqual(
    resultRelaySessionScopesForAccount(developer, env).sort(),
    relaySessionScopesForAccount(developer, env).sort()
  );
  assert.deepEqual(
    [...resultDeveloperAccountIds(developer)].sort(),
    [...developerAccountIds(developer)].sort()
  );
});

test('developer account allowlist fails closed on malformed or duplicate IDs', () => {
  assert.deepEqual([...developerAccountIds(undefined)], []);
  assert.deepEqual([...developerAccountIds('')], []);
  assert.deepEqual([...developerAccountIds(` ${developer.toUpperCase()} `)], [developer]);
  assert.throws(
    () => developerAccountIds('not-a-uuid'),
    (error: any) => error?.code === 'DEVELOPER_ACCOUNT_CONFIG_INVALID'
  );
  assert.throws(
    () => developerAccountIds(`${developer},${developer}`),
    (error: any) => error?.code === 'DEVELOPER_ACCOUNT_CONFIG_INVALID'
  );
});
