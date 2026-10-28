import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ActionRequest } from '../src/core/types.ts';
import {
  resourceKeysForAction, resolvePhysicalResourceKeysForAction
} from '../src/core/resource-identity.ts';

const root = path.join(os.tmpdir(), 'mecord-wave1-terminal-identity');
const req = (capability: string, input: Record<string, unknown>): ActionRequest => ({
  id: 'wave1-terminal-resource', capability, input,
  risk: capability === 'terminal.session' ? 'write' : 'destructive',
  provenance: { kind: 'runtime' }
});
const terminal = (resources: unknown) => req('terminal.execute', {
  cwd: root, affectedResources: resources
});
const session = (ports: unknown) => req('terminal.session', {
  operation: 'start', cwd: root, ports
});

test('C02/C06 terminal affected paths accept exact, dense plain descriptors', async () => {
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  const action = terminal([
    { kind: 'path', path: first },
    { kind: 'path', path: second }
  ]);
  const keys = resourceKeysForAction(action);
  assert.ok(keys.includes('file:' + first.replace(/\\/g, '/').toLowerCase()) ||
    keys.includes('file:' + first.replace(/\\/g, '/')));
  assert.equal(keys.length, 2);
  const physical = await resolvePhysicalResourceKeysForAction(action);
  assert.ok(physical.some(key => key.startsWith('fs-path:')));
});

test('C02/C06 sparse or executable terminal effect declarations fail before scheduling', async () => {
  let invoked = 0;
  const fake = {
    toString() { invoked++; return path.join(root, 'injected.txt'); }
  };
  const getterPath: Record<string, unknown> = { kind: 'path' };
  Object.defineProperty(getterPath, 'path', {
    enumerable: true, get() { invoked++; return path.join(root, 'injected.txt'); }
  });
  const accessorList: unknown[] = [];
  Object.defineProperty(accessorList, '0', {
    enumerable: true, get() { invoked++; return { kind:'path',path:root }; }
  });
  accessorList.length = 1;
  const customIterator = [{ kind: 'path', path: root }] as any;
  customIterator[Symbol.iterator] = function* () {
    invoked++; yield { kind:'path',path:root };
  };
  const extra = [{ kind: 'path', path: root }] as any;
  extra.hidden = true;
  const oneHole = Array(2);
  oneHole[0] = { kind: 'path', path: root };
  const invalid = [
    oneHole, accessorList, customIterator, extra, [{ kind: 'path', path: fake }],
    [getterPath],
    [{ kind: 'path', path: root, extra: 'unapproved' }],
    [{ path: root }], [{ kind: 'file', path: root }],
    [new Date()], new Array(129).fill({ kind: 'path', path: root })
  ];
  for (const [i, value] of invalid.entries()) {
    assert.throws(() => resourceKeysForAction(terminal(value)),
      (error: any) => error?.code === 'RESOURCE_DECLARATION_INVALID',
      'malformed terminal effect declaration ' + i);
    await assert.rejects(resolvePhysicalResourceKeysForAction(terminal(value)),
      (error: any) => error?.code === 'RESOURCE_DECLARATION_INVALID',
      'physical resource resolution must refuse malformed declaration ' + i);
  }
  const input: Record<string, unknown> = { cwd: root };
  Object.defineProperty(input, 'affectedResources', {
    enumerable: true, get() { invoked++; return []; }
  });
  assert.throws(() => resourceKeysForAction(req('terminal.execute',input)),
    (error:any)=>error?.code==='RESOURCE_TARGET_INVALID');
  assert.equal(invoked, 0, 'terminal resource parsing cannot execute hostile hooks');
});

test('C02/C06 TCP declaration never iterates inherited or forged array iterators', () => {
  let invoked = 0;
  const spoof = { valueOf() { invoked++; return 8080; } };
  const extra = [8080] as any;
  extra.unexpected = true;
  const iterator = [8080] as any;
  iterator[Symbol.iterator] = () => { invoked++; return [8080][Symbol.iterator](); };
  const hole = Array(2);
  hole[0] = 8080;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor,'0',{enumerable:true,
    get(){invoked++;return 8080;}});
  accessor.length=1;
  for (const ports of [
    extra, iterator, hole, accessor, [spoof], [8080.5], [65536], new Array(129).fill(8080)
  ]) {
    assert.throws(() => resourceKeysForAction(session(ports)),
      (error: any) => error?.code === 'RESOURCE_TARGET_INVALID');
  }
  const getterInput: Record<string, unknown> = { operation:'start',cwd:root };
  Object.defineProperty(getterInput, 'ports', {enumerable:true,
    get(){invoked++;return [8080];}});
  assert.throws(() => resourceKeysForAction(req('terminal.session',getterInput)),
    (error:any)=>error?.code==='RESOURCE_TARGET_INVALID');
  assert.equal(invoked,0);
  assert.ok(resourceKeysForAction(session([8080,5432])).includes('network:tcp:5432'));
});
