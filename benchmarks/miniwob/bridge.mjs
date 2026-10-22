import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const providerRoot=process.env.MECORD_PROVIDER_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const { BrowserCdpProvider }=await import(pathToFileURL(path.join(providerRoot,'src','capabilities','browser-cdp.ts')).href);
const cdpPort=String(process.env.MECORD_BENCH_CDP_PORT||'9360');
if(!/^9[0-9]{3}$/.test(cdpPort))throw Error('ISOLATED_PORT_ONLY');
const endpoint='http://127.0.0.1:'+cdpPort;
const urlPrefix=String(process.env.MINIWOB_URL||'');
if(!urlPrefix.startsWith('file:///')||!urlPrefix.endsWith('/'))throw Error('ISOLATED_MINIWOB_URL_REQUIRED');
const cssSegment='[a-z][a-z0-9-]*:nth-of-type\\([1-9][0-9]{0,3}\\)';
const safeDomSelector=new RegExp('^'+cssSegment+'(?: > '+cssSegment+'){0,13}$');
let provider=new BrowserCdpProvider(endpoint);
let index=0;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.url!=='/execute'||req.method!=='POST'){res.writeHead(404);res.end('{}');return;}
 let payload='';
 try {
   for await (const chunk of req){payload+=String(chunk);if(payload.length>12000)throw Error('TOO_LARGE');}
   const incoming=JSON.parse(payload);
   const targets=await (await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(4000)})).json();
   const pages=targets.filter(x=>x.type==='page'&&typeof x.url==='string'&&x.url.startsWith(urlPrefix));
   if(pages.length!==1)throw Error('PAGE_SCOPE_INVALID');
   const targetId=pages[0].id;
   const op=String(incoming.op||'');
   if(!['click','hover','type','set_value','select','key_press'].includes(op))throw Error('OP_DENIED');
   const bid=String(incoming.bid||'');
   if(!/^(?:[0-9]{1,6}|dom[0-9]{1,6})$/.test(bid))throw Error('INVALID_ID');
   let css='[bid="'+bid+'"]';
   if(bid.startsWith('dom')){
      if(typeof incoming.css!=='string'||!safeDomSelector.test(incoming.css))throw Error('UNTRUSTED_SELECTOR');
      css=incoming.css;
   }
   const result=await provider.execute({id:'restored-browser-'+(++index),capability:'browser.interact',risk:'external',
      input:{targetId,operation:op,target:{css},
       ...(typeof incoming.value==='string'?{value:incoming.value.slice(0,400)}:{}),
       ...(typeof incoming.key==='string'?{key:incoming.key.slice(0,32)}:{})},
      provenance:{kind:'runtime',source:'synthetic-miniwob'}});
   res.end(JSON.stringify({ok:result.ok,provider:result.provider,error:result.error?.code||null,durationMs:result.durationMs}));
 } catch(e){res.writeHead(400);res.end(JSON.stringify({ok:false,error:String(e.message||e).slice(0,100)}));}
});
server.listen(0,'127.0.0.1',()=>console.log('MECORD_BRIDGE_PORT='+server.address().port));
process.on('SIGTERM',()=>{provider.close();server.close()});
