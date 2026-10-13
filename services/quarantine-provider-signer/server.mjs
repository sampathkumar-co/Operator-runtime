// Independent HTTPS/mTLS service: host, administrator, provider API and backup domain
// MUST be separate from the Mecord relay/agent. No development credentials/default signer.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {createSigner} from './provider-origin-signer.mjs';

async function fileFromEnv(env,name) {
  const filename=env[name];
  if (!filename || !path.isAbsolute(filename)) throw new Error('SIGNER_CONFIG_INCOMPLETE');
  const stat=await fs.stat(filename);
  if (!stat.isFile() || stat.size < 32 || stat.size > 16384
    || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('SIGNER_FILE_UNSAFE');
  return fs.readFile(filename);
}
export function originUrl(value) {
  const u=new URL(value);
  // An off-domain provider must not silently resolve to a local service through
  // IPv6 literals, IPv4-mapped IPv6, trailing-dot localhost or mDNS aliases.
  const hostname=u.hostname.toLowerCase().replace(/\.$/, '');
  const literal=hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1,-1) : hostname;
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port
    || net.isIP(literal) !== 0 || hostname === 'localhost'
    || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || !hostname.includes('.'))
    throw new Error('ORIGIN_URL_INVALID');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}
async function boundedJson(response,maxBytes) {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
    throw new Error('ORIGIN_UNAVAILABLE');
  const reader=response.body?.getReader();
  if (!reader) throw new Error('ORIGIN_INVALID');
  let size=0; const chunks=[];
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>maxBytes) throw new Error('ORIGIN_RESPONSE_OVERSIZED');
      chunks.push(Buffer.from(value));
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
}
async function readBoundedBody(req,maxBytes) {
  const chunks=[];let total=0;
  for await(const chunk of req) {
    total+=chunk.length;
    if(total>maxBytes) throw new Error('REQUEST_OVERSIZED');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks,total).toString('utf8'));
}
export async function start(env=process.env) {
  const vars=['SIGNER_TLS_CERT_FILE','SIGNER_TLS_KEY_FILE','SIGNER_CLIENT_CA_FILE',
    'SIGNER_PRIVATE_KEY_FILE','SIGNER_ORIGIN_PUBKEY_FILE','SIGNER_REQUEST_TOKEN_FILE',
    'SIGNER_ORIGIN_TOKEN_FILE'];
  if (vars.some(v=>!env[v]) || !env.SIGNER_ORIGIN_API_URL || !env.SIGNER_ORIGIN_ISSUER)
    throw new Error('SIGNER_CONFIG_INCOMPLETE');
  if(new Set(vars.map(v=>path.resolve(env[v]))).size!==vars.length)throw new Error('SIGNER_FILE_REUSE');
  const [cert,key,ca,signerPem,originPem,requestKey,originKey]=await Promise.all(vars.map(v=>fileFromEnv(env,v)));
  const token=requestKey.toString('utf8').trim(),upstreamToken=originKey.toString('utf8').trim();
  if(token.length<32 || upstreamToken.length<32 || token===upstreamToken)throw new Error('SIGNER_TOKEN_INVALID');
  const origin=originUrl(env.SIGNER_ORIGIN_API_URL);
  const sign=createSigner({requestToken:token,signerPrivateKey:signerPem,
    originPublicKey:originPem,issuer:env.SIGNER_ORIGIN_ISSUER,
    lookup:async query=>{
      const url=new URL('v1/creation-origin',origin);
      for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
      const response=await fetch(url,{headers:{authorization:'Bearer '+upstreamToken,accept:'application/json'},
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)});
      return boundedJson(response,8192);
    }});
  const fingerprint=crypto.createHash('sha256')
    .update(crypto.createPublicKey(signerPem).export({type:'spki',format:'der'})).digest('hex');
  const server=https.createServer({cert,key,ca,requestCert:true,rejectUnauthorized:true,
    minVersion:'TLSv1.3'},async(req,res)=>{
    res.setHeader('cache-control','no-store');
    const send=(status,body)=>{
      res.writeHead(status,{'content-type':'application/json'});
      res.end(JSON.stringify(body));
    };
    if(req.url==='/health' && req.method==='GET')
      return send(200,{ready:true,pubkeyFingerprintSha256:fingerprint});
    if(req.url!=='/v1/provider-claims/sign'||req.method!=='POST')
      return send(404,{error:'NOT_FOUND'});
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')
      return send(415,{error:'CONTENT_TYPE_INVALID'});
    try{
      const header=req.headers.authorization??'';
      const provided=header.startsWith('Bearer ')?header.slice(7):'';
      const request=await readBoundedBody(req,4096);
      const result=await sign(provided,request);
      return send(200,result);
    }catch(error){
      const code=error?.code||error?.message;
      const status=code==='REQUEST_UNAUTHORIZED'?401:code==='REQUEST_INVALID'?400:503;
      return send(status,{error:status===503?'SIGNER_DENIED':code});
    }
  });
  const port=Number(env.SIGNER_PORT||8443);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('SIGNER_PORT_INVALID');
  server.listen(port,env.SIGNER_BIND_HOST||'127.0.0.1',()=>{
    console.log(JSON.stringify({status:'READY',port,pubkeyFingerprintSha256:fingerprint}));
  });
  return server;
}
if(process.argv[1] && import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href)
  start().catch(()=>{console.error('SIGNER_BOOT_FAILED');process.exitCode=1;});
