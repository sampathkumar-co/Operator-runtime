import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type GatewayEventKind =
  | 'operation.started'
  | 'operation.completed'
  | 'operation.failed'
  | 'capability.certified'
  | 'capability.revoked'
  | 'device.changed';

export interface GatewayWebhookSubscription {
  schemaVersion: 1;
  id: string;
  endpoint: string;
  eventKinds: GatewayEventKind[];
  enabled: boolean;
  createdAt: string;
}

export interface GatewayEventEnvelope {
  schemaVersion: 1;
  id: string;
  kind: GatewayEventKind;
  occurredAt: string;
  subjectId: string;
  data: Record<string, unknown>;
}

const KINDS: GatewayEventKind[] = [
  'operation.started','operation.completed','operation.failed',
  'capability.certified','capability.revoked','device.changed'
];

export function createGatewayWebhookSubscription(input: {
  id: string;
  endpoint: string;
  eventKinds: GatewayEventKind[];
  enabled?: boolean;
  createdAt?: string;
}): GatewayWebhookSubscription {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw invalid('Webhook endpoint must be credential-free HTTPS.');
  }
  if (isPrivateHost(endpoint.hostname)) throw invalid('Webhook endpoint cannot target loopback or private hosts.');
  const eventKinds = [...new Set(input.eventKinds.map(kind))].sort();
  if (eventKinds.length < 1) throw invalid('Webhook subscription requires at least one event kind.');
  return {
    schemaVersion: 1,
    id: id(input.id,'id'),
    endpoint: endpoint.toString(),
    eventKinds,
    enabled: input.enabled ?? true,
    createdAt: iso(input.createdAt ?? new Date().toISOString(),'createdAt')
  };
}

export function createGatewayEvent(input: {
  kind: GatewayEventKind;
  occurredAt?: string;
  subjectId: string;
  data?: Record<string, unknown>;
}): GatewayEventEnvelope {
  const base = {
    schemaVersion: 1 as const,
    kind: kind(input.kind),
    occurredAt: iso(input.occurredAt ?? new Date().toISOString(),'occurredAt'),
    subjectId: id(input.subjectId,'subjectId'),
    data: safeData(input.data ?? {})
  };
  return { ...base, id: crypto.createHash('sha256').update(canonicalJson(base),'utf8').digest('hex') };
}

export function signGatewayEvent(eventInput: GatewayEventEnvelope, secret: string): {
  body: string;
  signature: string;
  headers: Record<string,string>;
} {
  const event = validateGatewayEvent(eventInput);
  if (typeof secret !== 'string' || Buffer.byteLength(secret,'utf8') < 32) throw invalid('Webhook signing secret must be at least 32 bytes.');
  const body = canonicalJson(event);
  const signature = crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');
  return {
    body,
    signature,
    headers: {
      'content-type':'application/json',
      'x-mecord-event-id':event.id,
      'x-mecord-signature-sha256':signature
    }
  };
}

export function verifyGatewayEventSignature(body:string, signature:string, secret:string):boolean {
  if (!/^[0-9a-f]{64}$/.test(signature) || Buffer.byteLength(secret,'utf8') < 32) return false;
  const expected=crypto.createHmac('sha256',secret).update(body,'utf8').digest('hex');
  const a=Buffer.from(expected),b=Buffer.from(signature);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

export function validateGatewayEvent(input:GatewayEventEnvelope):GatewayEventEnvelope {
  if(!input||input.schemaVersion!==1) throw invalid('Gateway event shape is invalid.');
  const base={schemaVersion:1 as const,kind:kind(input.kind),occurredAt:iso(input.occurredAt,'occurredAt'),subjectId:id(input.subjectId,'subjectId'),data:safeData(input.data)};
  const expected=crypto.createHash('sha256').update(canonicalJson(base),'utf8').digest('hex');
  if(input.id!==expected) throw invalid('Gateway event id does not match content.');
  return {...base,id:expected};
}

function safeData(input:unknown):Record<string,unknown>{
  if(!input||typeof input!=='object'||Array.isArray(input)) throw invalid('Gateway event data must be an object.');
  const text=canonicalJson(input);
  if(Buffer.byteLength(text,'utf8')>256*1024) throw invalid('Gateway event data exceeds 256 KiB.');
  return structuredClone(input as Record<string,unknown>);
}
function kind(input:unknown):GatewayEventKind{if(!KINDS.includes(input as GatewayEventKind))throw invalid('Gateway event kind is invalid.');return input as GatewayEventKind;}
function id(input:unknown,label:string):string{const v=String(input??'');if(!/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(v))throw invalid(label+' is invalid.');return v;}
function iso(input:unknown,label:string):string{const v=String(input??'');if(!v||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)throw invalid(label+' must be canonical ISO.');return v;}
function isPrivateHost(host:string):boolean{
  const h=host.toLowerCase();
  if(h==='localhost'||h==='::1'||h.endsWith('.localhost'))return true;
  if(/^127./.test(h)||/^10./.test(h)||/^192.168./.test(h))return true;
  const m=h.match(/^172.(\d+)\./); if(m&&Number(m[1])>=16&&Number(m[1])<=31)return true;
  return false;
}
function invalid(message:string):OperatorError{return new OperatorError('GATEWAY_WEBHOOK_INVALID',message);}
