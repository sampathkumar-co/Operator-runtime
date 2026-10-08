import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPinnedHttpsArtifactFetch,
  createPinnedPublicDnsLookup,
  isGloballyRoutableDnsAnswer,
  type DnsAnswer
} from '../src/core/pinned-https-fetch.ts';

test('outbound DNS blocks reserved, private, transition and mapped network addresses', () => {
  for (const address of [
    '127.0.0.1','10.0.0.4','100.100.100.100','169.254.169.254',
    '172.31.1.1','192.168.1.2','192.0.2.1','198.18.0.1',
    '203.0.113.1','224.0.0.1','0.0.0.0','255.255.255.255',
    '::1','fe80::1','fc00::1','::ffff:127.0.0.1',
    '::ffff:8.8.8.8','2001:db8::1','2002:c0a8:0101::1',
    'not-an-ip'
  ]) {
    assert.equal(isGloballyRoutableDnsAnswer(address),false,address);
  }
  for (const address of ['1.1.1.1','8.8.8.8','9.9.9.9','2606:4700:4700::1111','2001:4860:4860::8888']) {
    assert.equal(isGloballyRoutableDnsAnswer(address),true,address);
  }
});

function resolved(answers: DnsAnswer[], all=false) {
  return new Promise<{error:Error|null;address?:string|DnsAnswer[];family?:number}>((done) => {
    createPinnedPublicDnsLookup((_hostname,callback)=>callback(null,answers))(
      'objects.vendor.com',{all},(error,address,family)=>done({error,address,family})
    );
  });
}

test('pinned DNS rejects all replies containing a private A or AAAA answer', async () => {
  const publicOnly=await resolved([{address:'8.8.8.8',family:4}]);
  assert.equal(publicOnly.error,null);
  assert.equal(publicOnly.address,'8.8.8.8');
  assert.equal(publicOnly.family,4);

  const all=await resolved([{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}],true);
  assert.equal(all.error,null);
  assert.equal((all.address as DnsAnswer[]).length,2);

  for (const bad of [
    [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],
    [{address:'2606:4700:4700::1111',family:6},{address:'fe80::1',family:6}],
    [{address:'::ffff:127.0.0.1',family:6}],
    [{address:'8.8.8.8',family:6}],
    [],
    Array.from({length:33},()=>({address:'8.8.8.8',family:4}))
  ] as DnsAnswer[][]) {
    const answer=await resolved(bad);
    assert.equal((answer.error as any)?.code,'UNSAFE_PUBLIC_NETWORK_TARGET');
  }
});

test('default pinned HTTP transport revalidates HTTPS policy before dialing', async () => {
  const fetch=createPinnedHttpsArtifactFetch({mode:'public-dns'});
  await assert.rejects(fetch('https://169.254.169.254/latest/meta-data'), (error:any)=>
    error?.code==='UNSAFE_PUBLIC_NETWORK_TARGET');
  await assert.rejects(fetch('http://objects.vendor.com/file'), (error:any)=>
    error?.code==='UNSAFE_PUBLIC_NETWORK_TARGET');
  await assert.rejects(fetch('https://objects.vendor.com/file',{method:'POST'}), (error:any)=>
    error?.code==='ARTIFACT_OBJECT_STORE_INVALID');
});
