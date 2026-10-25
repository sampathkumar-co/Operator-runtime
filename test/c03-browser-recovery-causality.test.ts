import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { BrowserCdpInspectProvider, absentBrowserTargetChecks,
  browserFocusActuallyProven, exactNavigationReconciliationTarget } from '../src/capabilities/browser-cdp.ts';

test('C03 observed destination is not causal evidence for unbound navigation or new tab creation',async t=>{
  const tabs=[
    {id:'already-open',type:'page',url:'https://example.com/payment#confirmed',title:'Existing checkout'},
    {id:'other',type:'page',url:'https://example.com/',title:'Elsewhere'}
  ];
  assert.equal(exactNavigationReconciliationTarget(tabs,undefined,'https://example.com/payment#confirmed'),undefined);
  assert.equal(exactNavigationReconciliationTarget(tabs,'other','https://example.com/payment#confirmed'),undefined);
  assert.equal(exactNavigationReconciliationTarget(tabs,'already-open','https://example.com/payment#different'),undefined);
  assert.equal(exactNavigationReconciliationTarget(tabs,'already-open','https://example.com/payment#confirmed')?.id,'already-open');
  let discoveries=0;
  const server=http.createServer((req,res)=>{
    if(req.url==='/json/list'){
      discoveries++;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(tabs));return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('Invalid fake discovery listener');
  const provider=new BrowserCdpInspectProvider('http://127.0.0.1:'+address.port);
  t.after(()=>provider.close());
  const action:any={id:'uncertain-nav',capability:'browser.navigate',risk:'external',
    input:{url:'https://example.com/payment#confirmed'},provenance:{kind:'runtime'}};
  const unbound=await provider.reconcile({action});
  assert.equal(unbound.status,'uncertain');
  assert.equal(unbound.result,undefined);
  const newTab=await provider.reconcile({action:{...action,input:{...action.input,newTab:true}}});
  assert.equal(newTab.status,'uncertain');
  assert.equal(newTab.result,undefined);
  const bound=await provider.reconcile({action:{...action,input:{...action.input,targetId:'already-open'}}});
  assert.equal(bound.status,'completed');
  assert.equal((bound.result?.output as any).targetId,'already-open');
  assert.equal(discoveries,3);
});

test('C03 tab focus needs actual focused document, not mere visibility',()=>{
  for(const input of [undefined,null,false,'visible',[],{}, {visible:true},
    {visible:true,focused:false},{visible:false,focused:true},
    {visible:'true',focused:true},{visible:true,focused:1}
  ])assert.equal(browserFocusActuallyProven(input),false);
  assert.equal(browserFocusActuallyProven({visible:true,focused:true}),true);
});

test('C07 absent targets cannot satisfy arbitrary expected fields through omitted checks',()=>{
  const one=absentBrowserTargetChecks({exists:false});
  assert.equal(one.length,1);
  assert.equal(one[0].pass,true);
  const forged=absentBrowserTargetChecks({exists:false,checked:true,expanded:false,value:'paid',selected:false});
  assert.equal(forged.length,5);
  assert.equal(forged[0].pass,true);
  assert.equal(forged.slice(1).every(check=>check.pass===false&&check.actual===undefined),true);
  assert.deepEqual(forged.slice(1).map(check=>check.field),['value','checked','selected','expanded']);
});
