function semver(v){
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) throw new Error('Gateway adapter version must be SemVer.');
  return v;
}
function normalizeBaseUrl(baseUrl){
  const url=new URL(baseUrl);
  if(!['https:','http:'].includes(url.protocol)) throw new Error('Gateway baseUrl must use HTTP(S).');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','::1'].includes(url.hostname)) throw new Error('Plain HTTP is restricted to loopback.');
  return url;
}
function hmacHex(body, secret){
  if(typeof secret!=='string'||new TextEncoder().encode(secret).byteLength<32) throw new Error('Webhook verification secret must be at least 32 bytes.');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']).then(key=>crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).then(sig=>Array.from(new Uint8Array(sig),b=>b.toString(16).padStart(2,'0')).join(''));
}
export class MecordGatewayClient {
  #baseUrl; #token; #fetch;
  constructor(options){
    this.#baseUrl=normalizeBaseUrl(options.baseUrl);
    this.#token=options.bearerToken;
    this.#fetch=options.fetchImpl??fetch;
  }
  proposal(input){return {schemaVersion:1,...input,proposedAt:input.proposedAt??new Date().toISOString()};}
  async execute(proposal){
    const token=typeof this.#token==='function'?await this.#token():this.#token;
    if(typeof token!=='string'||token.length<16) throw new Error('Gateway bearer token is invalid.');
    const response=await this.#fetch(new URL('/v1/gateway/execute',this.#baseUrl),{
      method:'POST',redirect:'error',
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
      body:JSON.stringify(proposal)
    });
    const body=await response.json();
    if(!response.ok){const error=new Error(body?.error?.message??`Gateway rejected request with HTTP ${response.status}.`);error.code=body?.error?.code;throw error;}
    return body;
  }
}
class FixedGatewayTransportAdapter {
  constructor(transport, adapterVersion='1.0.0'){this.transport=transport;this.adapterVersion=semver(adapterVersion);}
  propose(input){return {schemaVersion:1,transport:this.transport,principalId:input.principalId,executionContext:input.executionContext,action:input.action,adapterVersion:this.adapterVersion,proposedAt:input.proposedAt??new Date().toISOString()};}
}
export const mcpGatewayAdapter=(version)=>new FixedGatewayTransportAdapter('mcp',version);
export const openAiGatewayAdapter=(version)=>new FixedGatewayTransportAdapter('openai',version);
export const automationGatewayAdapter=(version)=>new FixedGatewayTransportAdapter('automation',version);
export const localSdkGatewayAdapter=(version)=>new FixedGatewayTransportAdapter('local-sdk',version);
export const enterpriseGatewayAdapter=(version)=>new FixedGatewayTransportAdapter('enterprise-sdk',version);

export function gatewayWebhookSubscription(input){
  const endpoint=new URL(input.endpoint);
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash) throw new Error('Webhook endpoint must be credential-free HTTPS.');
  const h=endpoint.hostname.toLowerCase();
  if(h==='localhost'||h==='::1'||h.endsWith('.localhost')||/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h)||(()=>{const m=h.match(/^172\.(\d+)\./);return !!(m&&Number(m[1])>=16&&Number(m[1])<=31);})()) throw new Error('Webhook endpoint cannot target loopback or private hosts.');
  if(!Array.isArray(input.eventKinds)||input.eventKinds.length<1) throw new Error('Webhook subscription requires at least one event kind.');
  return {schemaVersion:1,id:input.id,endpoint:endpoint.toString(),eventKinds:[...new Set(input.eventKinds)].sort(),enabled:input.enabled??true,createdAt:input.createdAt??new Date().toISOString()};
}
export class MecordWebhookVerifier {
  #secret;
  constructor(secret){if(typeof secret!=='string'||new TextEncoder().encode(secret).byteLength<32) throw new Error('Webhook verification secret must be at least 32 bytes.');this.#secret=secret;}
  async verify(body,signature){
    if(!/^[0-9a-f]{64}$/.test(signature)) throw new Error('Webhook signature is invalid.');
    const expected=await hmacHex(body,this.#secret);
    if(expected!==signature) throw new Error('Webhook signature is invalid.');
    return JSON.parse(body);
  }
}
