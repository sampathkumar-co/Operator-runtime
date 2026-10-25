import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LoopbackChatModelGoalGenerator } from '../src/core/loopback-chat-model-goal-generator.ts';
import { BoundedModelGoalInference } from '../src/core/bounded-model-goal-inference.ts';

async function local(t: test.TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject); server.listen(0,'127.0.0.1',resolve);
  });
  t.after(async ()=>{server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();
  if (!address || typeof address==='string') throw Error('expected TCP server address');
  return 'http://127.0.0.1:' + address.port + '/v1/chat/completions';
}
function reply(res:http.ServerResponse, status:number, body:unknown) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
const scopedProposal={goal:{kind:'browser-navigation',url:'https://allowed.example/page'},
  successConditions:['Observe navigation result from the browser provider']};
const scopedRequest={objective:'Visit the approved page',
  approvedBrowserOrigins:['https://allowed.example'],approvedRoots:[]};

test('C05 literal-loopback local chat transport sends a bounded prompt with no credentials and returns strict model message', async t=>{
  let seen=false;
  const endpoint=await local(t,async(req,res)=>{
    seen=true;
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
    assert.equal(req.headers.authorization,undefined);
    assert.equal(req.headers.cookie,undefined);
    let raw='';
    for await(const part of req) raw+=part.toString('utf8');
    const body=JSON.parse(raw);
    assert.equal(body.model,'chosen-local-model');
    assert.equal(body.max_tokens,256);
    assert.equal(body.stream,false);
    assert.equal(body.temperature,0);
    assert.equal(body.messages[0].role,'system');
    assert.equal(body.messages[1].role,'user');
    assert.equal(body.messages[1].content,'Scoped objective');
    reply(res,200,{choices:[{message:{role:'assistant',content:JSON.stringify(scopedProposal)}}]});
  });
  const generator=new LoopbackChatModelGoalGenerator({endpoint});
  const result=await generator.generate({
    modelId:'chosen-local-model',prompt:'Scoped objective',
    maxOutputTokens:256,signal:new AbortController().signal
  });
  assert.deepEqual(JSON.parse(result.text),scopedProposal);
  assert.equal(seen,true);
});
test('C05 model scope consent and durable pre-call reservation precede any network request',async t=>{
  const order:string[]=[];
  const endpoint=await local(t,(_req,res)=>{
    order.push('network');
    reply(res,200,{choices:[{message:{content:JSON.stringify(scopedProposal)}}]});
  });
  const generator=new LoopbackChatModelGoalGenerator({endpoint});
  const inference=new BoundedModelGoalInference({
    generator, modelId:'chosen-local-model',
    maxOutputTokens:256, maxCostMicros:0,timeoutMs:2000,
    ledger:{
      async reserve(){order.push('persist');return {reservationId:'demo-reservation'};},
      async finalize({outcome}){order.push('finalize:'+outcome);}
    }
  });
  await assert.rejects(inference.propose({
    scope:scopedRequest,allowModelTransmission:false as never
  }),(e:any)=>e.code==='TASK_MODEL_TRANSMISSION_DENIED');
  assert.deepEqual(order,[]);
  const proposed=await inference.propose({
    scope:scopedRequest,allowModelTransmission:true
  });
  assert.deepEqual(order,['persist','network','finalize:VALIDATED_PROPOSAL']);
  assert.equal(proposed.executionStarted,false);
  assert.deepEqual(proposed.proposal,scopedProposal);
});
test('C05 local model transport rejects SSRF, DNS hostname, credentials, redirects, foreign paths and URL queries',()=>{
  const invalid=[
    'http://localhost:11434/v1/chat/completions',
    'http://169.254.169.254:11434/v1/chat/completions',
    'http://10.0.0.2:11434/v1/chat/completions',
    'http://127.0.0.1:11434/admin',
    'https://127.0.0.1:11434/v1/chat/completions',
    'http://user:pass@127.0.0.1:11434/v1/chat/completions',
    'http://127.0.0.1:11434/v1/chat/completions?key=secret',
    'http://127.0.0.1:11434/v1/chat/completions#fragment',
    'http://127.0.0.1/v1/chat/completions'
  ];
  for(const endpoint of invalid)
    assert.throws(()=>new LoopbackChatModelGoalGenerator({endpoint}),
      (e:any)=>e.code==='TASK_MODEL_ENDPOINT_DENIED',endpoint);
});
test('C05 response is bounded even if HTTP server streams oversized output without content-length',async t=>{
  const endpoint=await local(t,(_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.write('x'.repeat(40_000));res.end();
  });
  const generator=new LoopbackChatModelGoalGenerator({endpoint});
  await assert.rejects(generator.generate({
    modelId:'chosen-local-model',prompt:'Hi',maxOutputTokens:256,
    signal:new AbortController().signal
  }),(e:any)=>e.code==='TASK_MODEL_RESPONSE_INVALID');
});
test('C05 redirect or non-success response never retries or contacts redirect target',async t=>{
  let count=0;
  const endpoint=await local(t,(_req,res)=>{
    count++;
    res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data'});
    res.end();
  });
  const generator=new LoopbackChatModelGoalGenerator({endpoint});
  await assert.rejects(generator.generate({
    modelId:'chosen-local-model',prompt:'Hi',maxOutputTokens:256,
    signal:new AbortController().signal
  }),(e:any)=>e.code==='TASK_MODEL_TRANSPORT_FAILED');
  assert.equal(count,1);
});
test('C05 malformed local chat body or aborted signal does not become a goal proposal',async t=>{
  let visits=0;
  const endpoint=await local(t,(_req,res)=>{
    visits++;
    reply(res,200,{choices:[{message:{content:null}}]});
  });
  const generator=new LoopbackChatModelGoalGenerator({endpoint});
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(generator.generate({
    modelId:'chosen-local-model',prompt:'Hi',maxOutputTokens:256,signal:cancelled.signal
  }),(e:any)=>e.code==='TASK_MODEL_INFERENCE_ABORTED');
  assert.equal(visits,0);
  await assert.rejects(generator.generate({
    modelId:'chosen-local-model',prompt:'Hi',maxOutputTokens:256,
    signal:new AbortController().signal
  }),(e:any)=>e.code==='TASK_MODEL_RESPONSE_INVALID');
  assert.equal(visits,1);
});
