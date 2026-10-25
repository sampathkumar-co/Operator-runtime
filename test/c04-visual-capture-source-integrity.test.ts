import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsUiaProvider } from '../src/capabilities/windows-uia.ts';

test('C04 malformed visual-capture scoping never starts a native screen capture',async()=>{
  let calls=0;
  const provider=new WindowsUiaProvider({platform:'win32',client:{
    async call(){calls++;throw new Error('unexpected native capture');},
    close(){}
  }});
  const baseline={source:'region',region:{x:0,y:0,width:100,height:100}};
  const cases=[
    {input:{source:['region'],region:baseline.region},code:'VISUAL_CAPTURE_INVALID'},
    {input:{source:'unknown',region:baseline.region},code:'VISUAL_CAPTURE_INVALID'},
    {input:{source:'screen',region:baseline.region},code:'VISUAL_CAPTURE_INVALID'},
    {input:{source:'screen',selector:{name:'Private window'}},code:'VISUAL_CAPTURE_INVALID'},
    {input:{source:'region',selector:{name:'Private window'},region:baseline.region},code:'VISUAL_CAPTURE_INVALID'},
    {input:{source:'window'},code:'INVALID_UIA_SELECTOR'},
    {input:{source:'window',selector:{name:['Private window']}},code:'INVALID_UIA_SELECTOR'},
    {input:{...baseline,region:{...baseline.region,x:['0']}},code:'VISUAL_INPUT_INVALID'},
    {input:{...baseline,region:{...baseline.region,width:'100'}},code:'VISUAL_INPUT_INVALID'},
    {input:{source:'screen',maxWidth:['960']},code:'VISUAL_INPUT_INVALID'},
    {input:{source:'screen',maxHeight:true},code:'VISUAL_INPUT_INVALID'},
    {input:{source:'screen',waitMs:'100'},code:'VISUAL_INPUT_INVALID'}
  ];
  try{
    for(const [index,item] of cases.entries()){
      const result=await provider.execute({id:'capture-invalid-'+index,capability:'visual.capture',
        risk:'read',provenance:{kind:'runtime'},input:item.input} as any);
      assert.equal(result.ok,false);
      assert.equal(result.error?.code,item.code,'Malformed capture cannot reach the native sidecar');
    }
    assert.equal(calls,0);
  } finally {provider.close();}
});

test('C04 native capture source mismatch cannot return unintended full-screen bytes',async()=>{
  let calls=0;
  const image=Buffer.alloc(40).toString('base64');
  const provider=new WindowsUiaProvider({platform:'win32',client:{
    async call(method){
      calls++;
      assert.equal(method,'capture');
      return {source:'screen',png_base64:image,origin_x:0,origin_y:0,
        source_width:100,source_height:100,returned_width:100,returned_height:100,
        scale_x:1,scale_y:1};
    },close(){}
  }});
  try{
    const result=await provider.execute({id:'wrong-screen-response',capability:'visual.capture',
      risk:'read',provenance:{kind:'runtime'},
      input:{source:'region',region:{x:0,y:0,width:100,height:100}}});
    assert.equal(calls,1);
    assert.equal(result.ok,false);
    assert.equal(result.error?.code,'VISUAL_CAPTURE_INVALID');
    assert.equal(result.output,undefined);
    assert.ok(!JSON.stringify(result).includes(image));
  }finally{provider.close();}
});

test('C04 native visual geometry must not accept coercible scale metadata',async()=>{
  const image=Buffer.alloc(40).toString('base64');
  const provider=new WindowsUiaProvider({platform:'win32',client:{
    async call(){return {source:'region',png_base64:image,origin_x:0,origin_y:0,
      source_width:100,source_height:100,returned_width:100,returned_height:100,
      scale_x:['1'],scale_y:1};},
    close(){}
  }});
  const result=await provider.execute({id:'invalid-scale',capability:'visual.capture',
    risk:'read',provenance:{kind:'runtime'},
    input:{source:'region',region:{x:0,y:0,width:100,height:100}}});
  assert.equal(result.ok,false);
  assert.equal(result.error?.code,'VISUAL_CAPTURE_INVALID');
  provider.close();
});
