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
