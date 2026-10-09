import assert from 'node:assert/strict';
import test from 'node:test';
import { actionHash, canonicalJson, stableActionId } from '../src/core/action-identity.ts';
import type { ActionRequest } from '../src/core/types.ts';

test('canonical JSON preserves own __proto__ data keys without prototype mutation or digest aliasing', () => {
  // JSON.parse produces a real own data property named __proto__. Object
  // assignment into {} used to silently drop this key during canonicalization.
  const special = JSON.parse('{"__proto__":{"authority":"elevated"},"ordinary":true}');
  const ordinary = { ordinary: true };
  assert.equal(Object.hasOwn(special, '__proto__'), true);
  assert.equal(canonicalJson(special), '{"__proto__":{"authority":"elevated"},"ordinary":true}');
  assert.equal(canonicalJson(ordinary), '{"ordinary":true}');
  assert.notEqual(canonicalJson(special), canonicalJson(ordinary));
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
});

test('nested prototype-named inputs cannot collide in action hashes or stable action IDs', () => {
  const plain = JSON.parse('{"payload":{"config":{"enabled":true}}}');
  const special = JSON.parse('{"payload":{"config":{"__proto__":{"root":true},"enabled":true}}}');
  assert.notEqual(canonicalJson(plain), canonicalJson(special));
  assert.equal(
    canonicalJson(special),
    '{"payload":{"config":{"__proto__":{"root":true},"enabled":true}}}'
  );
  const action = (input: Record<string, unknown>): ActionRequest => ({
    id: 'canonical-prototype-key',
    capability: 'file.write',
    risk: 'write',
    input,
    provenance: { kind: 'chatgpt' }
  });
  assert.notEqual(actionHash(action(plain)), actionHash(action(special)));
  assert.notEqual(
    stableActionId('file.write', 'write', plain),
    stableActionId('file.write', 'write', special)
  );
  assert.equal(
    canonicalJson(JSON.parse('[{"__proto__":{"flag":true}},{"__proto__":null}]')),
    '[{"__proto__":{"flag":true}},{"__proto__":null}]'
  );
});

test('ordinary canonical JSON remains deterministically order-independent', () => {
  const first = { z: { y: 2, a: 1 }, a: [{ q: true, b: null }] };
  const second = { a: [{ b: null, q: true }], z: { a: 1, y: 2 } };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(canonicalJson(first), '{"a":[{"b":null,"q":true}],"z":{"a":1,"y":2}}');
});
