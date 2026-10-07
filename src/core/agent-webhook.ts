import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface AgentWebhookSubscription {
  schemaVersion: 1;
  id: string;
  endpoint: string;
  eventTypes: string[];
  enabled: boolean;
}

export interface SignedAgentWebhook {
  schemaVersion: 1;
  deliveryId: string;
  subscriptionId: string;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  signature: string;
}

const MAX_PAYLOAD_BYTES=256*1024;

export function normalizeWebhookSubscription(input:AgentWebhookSubscription):AgentWebhookSubscription{
  if(!input||input.schemaVersion!==1) throw invalid('Webhook subscription schema is invalid.');
  const id=idValue(input.id,'subscription.id');
  let endpoint:URL;
  try{endpoint=new URL(String(input.endpoint??''));}catch{throw invalid('Webhook endpoint is invalid.');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash) throw invalid('Webhook endpoint must be credential-free HTTPS without fragments.');
  if(!Array.isArray(input.eventTypes)||input.eventTypes.length<1||input.eventTypes.length>128) throw invalid('Webhook eventTypes are invalid.');
  const eventTypes=[...new Set(input.eventTypes.map(eventType))].sort();
  if(typeof input.enabled!=='boolean') throw invalid('Webhook enabled flag is invalid.');
  return {schemaVersion:1,id,endpoint:endpoint.toString(),eventTypes,enabled:input.enabled};
}

export function signAgentWebhook(input:{
  subscription:AgentWebhookSubscription;
  deliveryId:string;
  eventType:string;
  occurredAt?:string;
  payload:Record<string,unknown>;
  secret:string|Uint8Array;
}):SignedAgentWebhook{
  const subscription=normalizeWebhookSubscription(input.subscription);
  const event=eventType(input.eventType);
  if(!subscription.enabled||!subscription.eventTypes.includes(event)) throw invalid('Webhook event is not enabled for this subscription.');
  const deliveryId=idValue(input.deliveryId,'deliveryId');
  const occurredAt=iso(input.occurredAt??new Date().toISOString(),'occurredAt');
  const payload=safePayload(input.payload);
  const payloadDigest=sha(canonicalJson(payload));
  const unsigned={schemaVersion:1 as const,deliveryId,subscriptionId:subscription.id,eventType:event,occurredAt,payload,payloadDigest};
  return {...unsigned,signature:hmac(input.secret,canonicalJson(unsigned))};
}

export function verifyAgentWebhook(input:SignedAgentWebhook,secret:string|Uint8Array):SignedAgentWebhook{
  if(!input||input.schemaVersion!==1) throw invalid('Webhook envelope schema is invalid.');
  const deliveryId=idValue(input.deliveryId,'deliveryId');
  const subscriptionId=idValue(input.subscriptionId,'subscriptionId');
  const type=eventType(input.eventType);
  const occurredAt=iso(input.occurredAt,'occurredAt');
  const payload=safePayload(input.payload);
  const payloadDigest=sha(canonicalJson(payload));
  if(payloadDigest!==String(input.payloadDigest??'').toLowerCase()) throw invalid('Webhook payload digest mismatch.');
  const unsigned={schemaVersion:1 as const,deliveryId,subscriptionId,eventType:type,occurredAt,payload,payloadDigest};
  const expected=hmac(secret,canonicalJson(unsigned));
  const supplied=String(input.signature??'');
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) throw new OperatorError('AGENT_WEBHOOK_SIGNATURE_INVALID','Webhook signature is invalid.');
  return {...unsigned,signature:supplied};
}

function hmac(secretInput:string|Uint8Array,payload:string):string{
  const secret=typeof secretInput==='string'?Buffer.from(secretInput,'utf8'):Buffer.from(secretInput);
  if(secret.byteLength<32||secret.byteLength>4096) throw invalid('Webhook secret must contain 32-4096 bytes.');
  return crypto.createHmac('sha256',secret).update(payload,'utf8').digest('base64url');
}
function safePayload(input:unknown):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input)) throw invalid('Webhook payload must be an object.');
  const encoded=canonicalJson(input);
  if(Buffer.byteLength(encoded,'utf8')>MAX_PAYLOAD_BYTES) throw invalid('Webhook payload exceeds 256 KiB.');
  return structuredClone(input as Record<string,unknown>);
}
function idValue(input:unknown,label:string):string{
  const value=String(input??'');if(!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(value)) throw invalid(label+' is invalid.');return value;
}
function eventType(input:unknown):string{
  const value=String(input??'');if(!/^[a-z][a-z0-9._:-]{0,127}$/.test(value)) throw invalid('Webhook eventType is invalid.');return value;
}
function iso(input:unknown,label:string):string{const v=String(input??'');if(!v||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw invalid(label+' must be canonical ISO.');return v;}
function sha(value:string):string{return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
function invalid(message:string):OperatorError{return new OperatorError('AGENT_WEBHOOK_INVALID',message);}
