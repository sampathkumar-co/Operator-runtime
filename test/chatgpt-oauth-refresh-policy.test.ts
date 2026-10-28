import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../deploy/auth-portal/authelia-oidc-policy.example.yml', import.meta.url), 'utf8');
function client(id: string) {
  const blocks = source.split(/(?=^  - client_id: ')/m).filter(block => block.startsWith("  - client_id: '" + id + "'"));
  assert.equal(blocks.length, 1, 'Each OAuth client must appear exactly once');
  return blocks[0];
}
test('public ChatGPT OAuth client supports token renewal and remains read/write only', () => {
  const c = client('splcart-operator-chatgpt-prod-8HymKNOT2aqK');
  for (const scope of ["'openid'", "'offline_access'", "'operator:read'", "'operator:write'"]) assert.ok(c.includes(scope));
  for (const grant of ["'authorization_code'", "'refresh_token'"]) assert.ok(c.includes(grant));
  assert.match(c, /requested_audience_mode: 'explicit'/);
  assert.match(c, /https:\/\/operator\.splcart\.in\/mcp/);
  assert.match(c, /pkce_challenge_method: 'S256'/);
  assert.match(c, /connector_platform_oauth_redirect/);
  assert.match(c, /connector\/oauth\/8HymKNOT2aqK/);
  assert.doesNotMatch(c, /operator:developer/);
});
test('developer scope stays isolated; device pairing does not inherit refresh access', () => {
  const dev = client('splcart-operator-chatgpt-developer-v1');
  assert.match(dev, /offline_access/); assert.match(dev, /refresh_token/);
  assert.match(dev, /operator:developer/);
  const pairing = client('mecord-device-pairing-v1');
  assert.doesNotMatch(pairing, /offline_access|refresh_token|operator:developer/);
});
