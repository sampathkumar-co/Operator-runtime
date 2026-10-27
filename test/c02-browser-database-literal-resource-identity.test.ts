import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resourceKeysForAction, resolvePhysicalResourceKeysForAction
} from '../src/core/resource-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

function req(capability: string, input: Record<string, unknown>): ActionRequest {
  return { id: 'c02-typed-namespace', capability, risk: 'read',
    input, provenance: { kind: 'runtime' } };
}
test('C02/C03 browser and database resource namespaces never coerce attacker-owned identity', async () => {
  let invoked = 0;
  const forged = {
    toString() { invoked++; return 'owned-session'; },
    valueOf() { invoked++; return 'owned-session'; }
  };
  const attempts = [
    req('browser.inspect', { sessionId: forged }),
    req('browser.inspect', { sessionId: ['owned-session'] }),
    req('browser.tab.focus', { sessionId: 'safe', targetId: forged }),
    req('browser.inspect', { sessionId: 'x'.repeat(300) }),
    req('postgres.select', { path: '/workspace', profileId: forged }),
    req('postgres.inspect', { path: '/workspace', profileId: ['my-db'] }),
    req('postgres.select', { path: '/workspace', profileId: 123 })
  ];
  for (const action of attempts) {
    assert.throws(
      () => resourceKeysForAction(action),
      (error: any) => error?.code === 'RESOURCE_TARGET_INVALID',
      'untrusted namespace refused before resource lease acquisition'
    );
    await assert.rejects(
      resolvePhysicalResourceKeysForAction(action),
      (error: any) => error?.code === 'RESOURCE_TARGET_INVALID',
      'physical resolver uses identical strict namespace checks'
    );
  }
  assert.equal(invoked, 0, 'no toString/valueOf callbacks may run');
});

test('C02 valid browser and PostgreSQL literal resource identities keep existing scope and fallbacks', async () => {
  const browser = resourceKeysForAction(req('browser.inspect', { sessionId: 'CASE-A' }));
  assert.deepEqual(browser, ['browser:instance:case-a/targets']);
  const defaultBrowser = resourceKeysForAction(req('browser.inspect', {}));
  assert.deepEqual(defaultBrowser, ['browser:instance:default/targets']);
  const database = resourceKeysForAction(req('postgres.inspect', { path: '/workspace', profileId: 'ProfileA' }));
  assert.equal(database.some(key => key.includes('/profile:profilea')), true);
  const keys = await resolvePhysicalResourceKeysForAction(req('postgres.inspect', { path: '/workspace', profileId: 'ProfileA' }));
  assert.equal(keys.some(key => key.startsWith('database:') && key.endsWith('/profile:profilea')), true);
  const missing = resourceKeysForAction(req('postgres.inspect', { path: '/workspace' }));
  assert.equal(missing.some(key => key.includes('/profile:profiles')), true);
});
