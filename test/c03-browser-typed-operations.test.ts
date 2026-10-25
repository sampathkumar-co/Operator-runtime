import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserCdpInspectProvider, browserVerificationProven, normalizeBrowserVerificationExpectations } from '../src/capabilities/browser-cdp.ts';
import { validateNavigationUrl } from '../src/capabilities/browser-cdp-page.ts';

test('C03 browser URL validation never stringifies forged array or object destinations', () => {
  const good = validateNavigationUrl('https://example.com/form?mode=edit#step-2');
  assert.equal(good, 'https://example.com/form?mode=edit#step-2');
  let sideEffects = 0;
  const hostile = { toString() { sideEffects += 1; return 'https://example.com/'; } };
  for(const bad of [
    ['https://example.com/'], hostile, 42, true, null, undefined,
    'https://example.com/' + String.fromCharCode(0),
    'https://example.com/' + String.fromCharCode(10),
    'https://example.com/' + String.fromCharCode(13),
    'https://example.com/' + 'x'.repeat(4096)
  ]) {
    assert.throws(() => validateNavigationUrl(bad), (error:any) => error?.code === 'INVALID_URL');
  }
  assert.equal(sideEffects,0);
});

test('C03 rejects malformed browser operations before contacting any CDP endpoint', async () => {
  const provider = new BrowserCdpInspectProvider('http://127.0.0.1:65534');
  const provenance = { kind: 'runtime' as const };
  const cases: Array<{ capability: string; input: Record<string,unknown>; error: string }> = [
    { capability:'browser.inspect', input:{targetId:['tab1']}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.verify', input:{targetId:['tab1'],expect:{exists:true}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.navigate', input:{url:['https://example.com/']}, error:'INVALID_URL' },
    { capability:'browser.navigate', input:{url:'https://example.com/',newTab:'true'}, error:'INVALID_BROWSER_TAB_MODE' },
    { capability:'browser.navigate', input:{url:'https://example.com/',newTab:true,targetId:'tab1'}, error:'INVALID_BROWSER_TAB_MODE' },
    { capability:'browser.navigate', input:{url:'https://example.com/',targetId:['tab1']}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.tab.close', input:{targetId:['tab1']}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.tab.focus', input:{targetId:{value:'tab1'}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.interact', input:{targetId:['tab1'],operation:'click',target:{ref:'b-1'}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:['click'],target:{ref:'b-1'}}, error:'INVALID_BROWSER_OPERATION' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'scroll',target:{ref:'b-1'},deltaX:'0',deltaY:100}, error:'INVALID_BROWSER_SCROLL' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'drag',target:{ref:'b-1'},deltaX:[50],deltaY:0}, error:'INVALID_BROWSER_DRAG' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'drag_between',target:{ref:'b-c0ff33-a-1'},toTarget:{ref:'b-c0ff33-b-2'}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'drag_between',target:{ref:'b-c0ff33-a-1'},toTarget:{ref:'b-c0ff33-a-1'}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'drag_between',target:{ref:'b-source'},toTarget:{ref:'b-destination'}}, error:'INVALID_BROWSER_TARGET' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'click_relative',target:{ref:'b-1'},xRatio:'0.25',yRatio:0.3}, error:'INVALID_BROWSER_POINT' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'click_relative',target:{ref:'b-1'},xPx:true,yPx:40}, error:'INVALID_BROWSER_POINT' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'keyboard_text',target:{ref:'b-1'},value:['hello']}, error:'INVALID_BROWSER_TEXT' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'select_date',target:{ref:'b-1'},value:['2026-10-25']}, error:'INVALID_BROWSER_DATE' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'format_text',target:{ref:'b-1'},value:['bold']}, error:'INVALID_BROWSER_FORMAT' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'key_press',target:{ref:'b-1'},key:['Enter']}, error:'INVALID_BROWSER_KEY' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'key_press',target:{ref:'b-1'},key:''}, error:'INVALID_BROWSER_KEY' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'hotkey',target:{ref:'b-1'},keys:[['CTRL'],'A']}, error:'INVALID_BROWSER_HOTKEY' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'hotkey',target:{ref:'b-1'},keys:['CTRL',42]}, error:'INVALID_BROWSER_HOTKEY' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'hotkey',target:{ref:'b-1'},keys:[]}, error:'INVALID_BROWSER_HOTKEY' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'select_text_range',target:{ref:'b-1'},start:'0',end:2}, error:'INVALID_BROWSER_TEXT_RANGE' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'select_text_range',target:{ref:'b-1'},start:2,end:1}, error:'INVALID_BROWSER_TEXT_RANGE' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'select_text_range',target:{ref:'b-1'},start:0,end:Infinity}, error:'INVALID_BROWSER_TEXT_RANGE' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'click',target:{ref:'b-1'},expectDownload:['true']}, error:'INVALID_DOWNLOAD_INTERACTION' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'click',target:{ref:'b-1'},expectDownload:true,downloadTimeoutMs:'30000'}, error:'INVALID_DOWNLOAD_TIMEOUT' },
    { capability:'browser.interact', input:{targetId:'tab1',operation:'click',target:{ref:'b-1'},expectDownload:true,downloadTimeoutMs:[30000]}, error:'INVALID_DOWNLOAD_TIMEOUT' }
  ];
  try {
    for (const [index, entry] of cases.entries()) {
      const result = await provider.execute({
        id:'pre-dispatch-invalid-'+index, capability:entry.capability,
        risk:entry.capability === 'browser.inspect' || entry.capability === 'browser.verify' ? 'read' : 'external',
        input:entry.input, provenance
      } as any);
      assert.equal(result.ok, false, entry.capability+' '+JSON.stringify(entry.input));
      assert.equal(result.error?.code, entry.error, entry.capability+' '+JSON.stringify(entry.input));
      assert.notEqual(result.error?.code,'ECONNREFUSED','input validation must precede CDP');
    }
  } finally { provider.close(); }
});

test('C03/C07 only genuinely passed browser goal postconditions may certify a reconciled interaction', async () => {
  const provider=new BrowserCdpInspectProvider('http://127.0.0.1:65534');
  const action:any={
    id:'attempt-postcondition',capability:'browser.interact',risk:'external',
    input:{targetId:'tab1',operation:'click',target:{ref:'b-c0ff33-1-2'},expect:{expanded:true}},
    provenance:{kind:'runtime'}
  };
  const sample=(status:string,checks:any[])=>({
    ok:true,capability:'browser.verify',provider:'browser.cdp',
    output:{status,targetId:'tab1',checks},evidence:[],durationMs:0
  });
  const responses=[
    [sample('NOT_COMPLETE',[{field:'expanded',pass:false}]),'uncertain'],
    [sample('INCONCLUSIVE',[{field:'expanded',pass:false}]),'uncertain'],
    [sample('VERIFIED',[]),'uncertain'],
    [sample('VERIFIED',[{field:'expanded',pass:false}]),'uncertain'],
    [sample('VERIFIED',[{field:'expanded',pass:true}]),'completed']
  ] as const;
  try {
    for(const [verification,expected] of responses) {
      (provider as any).execute=async()=>verification;
      assert.equal(browserVerificationProven(verification as any),expected==='completed');
      const reconciled=await provider.reconcile({action});
      assert.equal(reconciled.status,expected);
      if (expected !== 'completed') assert.equal(reconciled.result,undefined,
        'uncertain reconciliation never fabricates an ActionResult success');
    }
  } finally { provider.close(); }
});

test('C03 browser verification refuses vacuous, unknown or coercible expectations',()=>{
  assert.deepEqual(normalizeBrowserVerificationExpectations({exists:false}),{exists:false});
  assert.deepEqual(normalizeBrowserVerificationExpectations({expanded:true,titleContains:'Dashboard'}),{expanded:true,titleContains:'Dashboard'});
  let coercions=0;
  const poisoned={toString(){coercions++;return 'Checkout complete';}};
  for(const input of [
    {},null,[],{unsupported:true},{exists:undefined},{exists:'true'},
    {checked:['true']},{selected:1},{active:null},{expanded:'false'},
    {urlContains:''},{titleContains:'  '},{textContains:poisoned},
    {urlContains:['https://example.com']},{current:0},
    {value:['success']},{value:poisoned}
  ]) {
    assert.throws(()=>normalizeBrowserVerificationExpectations(input),
      (error:any)=>error?.code==='INVALID_BROWSER_VERIFICATION');
  }
  assert.equal(coercions,0);
});
