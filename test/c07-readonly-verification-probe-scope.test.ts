import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCanonicalVerificationRequest } from '../src/core/canonical-verification.ts';

const request = (capability:string) => ({probes:[{
  name:'postcondition',capability,input:{path:'/synthetic/source.txt'},
  assertions:[{path:'sha256',operator:'exists'}]
}]});

test('C07 canonical verification accepts registered genuinely read-only probes',()=>{
  for(const capability of ['file.read','file.info','git.status','git.diff','browser.inspect',
    'browser.verify','app.inspect','postgres.select','docker.inspect','visual.capture']) {
    const v=normalizeCanonicalVerificationRequest(request(capability));
    assert.equal(v.probes[0]?.capability,capability);
  }
});

test('C07 canonical goal verification refuses mutation, dynamic and unregistered capabilities before dispatch',()=>{
  for(const capability of ['file.create','file.replace','file.manage','git.write','browser.navigate',
    'browser.interact','browser.tab.focus','app.operate','input.operate','terminal.session',
    'project.command.run','process.manage','docker.manage','ext.example.unsafe','toString',
    'constructor','__proto__']) {
    assert.throws(()=>normalizeCanonicalVerificationRequest(request(capability)),
      (err:any)=>err?.code==='CANONICAL_VERIFICATION_INVALID',capability);
  }
});

test('C07 mixed verification probe lists reject a hidden mutation instead of partially executing safe reads',()=>{
  const expected=request('file.read');
  const mixed={probes:[expected.probes[0],{...request('git.write').probes[0],name:'hidden-mutation'}]};
  assert.throws(()=>normalizeCanonicalVerificationRequest(mixed),
    (err:any)=>err?.code==='CANONICAL_VERIFICATION_INVALID');
});

test('C07 verifier strictly checks probe shape and inert JSON without dispatch', () => {
  const valid = request('file.read');
  for (const hostile of [
    { ...valid, approvals: ['all'] },
    { probes: [{ ...valid.probes[0], risk: 'write' }] },
    { probes: [{ ...valid.probes[0], input: null }] },
    { probes: [{ ...valid.probes[0], input: { fn: () => 'execute' } }] },
    { probes: [{ ...valid.probes[0], input: { bytes: Number.NaN } }] },
    { probes: [{ ...valid.probes[0], input: { input: new Date() } }] },
    { probes: [{ ...valid.probes[0], input: { unsafe: undefined } }] },
    { probes: [{ ...valid.probes[0], input: { deep: 'x'.repeat(270 * 1024) } }] }
  ]) {
    assert.throws(
      () => normalizeCanonicalVerificationRequest(hostile),
      (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID'
    );
  }
  const cyclic: any = {}; cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'password', {
    enumerable: true, get() { throw new Error('must never evaluate accessor'); }
  });
  const hidden = Object.defineProperty({}, 'unlisted', { value: 'hidden' });
  for (const input of [cyclic, getter, hidden]) {
    assert.throws(
      () => normalizeCanonicalVerificationRequest({
        probes: [{ ...valid.probes[0], input }]
      }),
      (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID'
    );
  }
});

test('C07 read-only probe supports bounded nested JSON arrays and preserves exact data', () => {
  const valid = request('file.read');
  const nested = { selectors: [{ path: ['files', 'name'], enabled: true, limit: 4 }] };
  const normalized = normalizeCanonicalVerificationRequest({
    probes: [{ ...valid.probes[0], input: nested }]
  });
  assert.deepEqual(normalized.probes[0]?.input, nested);
  assert.notEqual(normalized.probes[0]?.input, nested);
});

test('C07 rejects sparse and symbol-bearing arrays instead of silently canonicalizing to null', () => {
  const valid = request('file.read');
  const sparse: unknown[] = new Array(2);
  sparse[1] = 'present';
  const extra = Object.assign(['valid'], { extraneous: 'dropped-by-json' });
  const symbolArray = ['valid'] as unknown[] & Record<symbol, unknown>;
  symbolArray[Symbol('proof')] = 'hidden';
  for (const input of [{ values: sparse }, { values: extra }, { values: symbolArray }]) {
    assert.throws(() => normalizeCanonicalVerificationRequest({
      probes: [{ ...valid.probes[0], input }]
    }), (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID');
  }
});

test('C07 rejects executable or hidden envelope fields before reading them', () => {
  const valid = request('file.read');
  let invoked = false;
  const getterRoot = Object.defineProperty({}, 'probes', {
    enumerable: true,
    get() { invoked = true; return valid.probes; }
  });
  const getterProbe = Object.defineProperty({ ...valid.probes[0] }, 'input', {
    enumerable: true,
    get() { invoked = true; return { path: '/synthetic' }; }
  });
  const hiddenEnvelope = Object.defineProperty({ ...valid }, 'policy', {
    enumerable: false, value: 'new-authority'
  });
  const symbolEnvelope = { ...valid, [Symbol('authority')]: true };
  for (const requestValue of [getterRoot, { probes: [getterProbe] }, hiddenEnvelope, symbolEnvelope]) {
    assert.throws(() => normalizeCanonicalVerificationRequest(requestValue),
      (error: any) => error?.code === 'CANONICAL_VERIFICATION_INVALID');
  }
  assert.equal(invoked, false);
});
