import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import { requireHttpsUrlForPolicy, type HttpsTargetPolicy } from './network-authority.ts';

const DIGEST=/^[0-9a-f]{64}$/;
const MAX_BYTES=64*1024*1024;

export interface ArtifactBlobBackend {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Buffer>;
}

export interface ArtifactObjectUrlProvider {
  putUrl(input: { digest: string; bytes: number }): Promise<string> | string;
  getUrl(input: { digest: string }): Promise<string> | string;
}

export interface ArtifactFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?(reason?: unknown): Promise<void> | void;
    };
  } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ArtifactFetch = (url: string, init?: {
  method?: string;
  headers?: Record<string,string>;
  body?: Uint8Array;
  redirect?: 'error';
}) => Promise<ArtifactFetchResponse>;

export class PresignedHttpsArtifactBlobBackend implements ArtifactBlobBackend {
  #urls: ArtifactObjectUrlProvider;
  #fetch: ArtifactFetch;
  #targetPolicy: HttpsTargetPolicy;

  constructor(
    urls: ArtifactObjectUrlProvider,
    fetchImpl: ArtifactFetch = globalThis.fetch as unknown as ArtifactFetch,
    options: { targetPolicy?: HttpsTargetPolicy } = {}
  ) {
    if (!urls || typeof urls.putUrl !== 'function' || typeof urls.getUrl !== 'function') {
      throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID','Object URL provider is invalid.');
    }
    if (typeof fetchImpl !== 'function') throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID','Object fetch implementation is invalid.');
    this.#urls=urls;
    this.#fetch=fetchImpl;
    this.#targetPolicy=options.targetPolicy ?? {mode:'public-dns'};
  }

  async put(digestInput:string,bytesInput:Uint8Array):Promise<void>{
    const digest=validDigest(digestInput);
    const bytes=Buffer.from(bytesInput);
    if(bytes.byteLength<1||bytes.byteLength>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact size is invalid.');
    if(sha256(bytes)!==digest) throw new OperatorError('ARTIFACT_INTEGRITY_FAILED','Object artifact bytes do not match their content address.');
    const url=validPresignedUrl(await this.#urls.putUrl({digest,bytes:bytes.byteLength}),this.#targetPolicy);
    const response=await this.#fetch(url,{
      method:'PUT',redirect:'error',body:bytes,
      headers:{'content-type':'application/octet-stream','content-length':String(bytes.byteLength),'x-mecord-sha256':digest}
    });
    if(!response.ok) throw new OperatorError('ARTIFACT_OBJECT_STORE_WRITE_FAILED',`Object store PUT failed with HTTP ${response.status}.`,{retryable:response.status>=500});
  }

  async get(digestInput:string):Promise<Buffer>{
    const digest=validDigest(digestInput);
    const url=validPresignedUrl(await this.#urls.getUrl({digest}),this.#targetPolicy);
    const response=await this.#fetch(url,{method:'GET',redirect:'error'});
    if(!response.ok) throw new OperatorError('ARTIFACT_OBJECT_STORE_READ_FAILED',`Object store GET failed with HTTP ${response.status}.`,{retryable:response.status>=500});
    const declared=response.headers.get('content-length');
    let declaredSize: number | undefined;
    if(declared!==null){
      declaredSize=Number(declared);
      if(!Number.isSafeInteger(declaredSize)||declaredSize<1||declaredSize>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact content length is invalid.');
    }
    const bytes=await readBoundedResponse(response,declaredSize);
    if(sha256(bytes)!==digest) throw new OperatorError('ARTIFACT_INTEGRITY_FAILED','Object artifact download failed digest verification.');
    return bytes;
  }
}

async function readBoundedResponse(response:ArtifactFetchResponse,declaredSize?:number):Promise<Buffer>{
  if(response.body&&typeof response.body.getReader==='function'){
    const reader=response.body.getReader();
    const chunks:Buffer[]=[]; let total=0;
    while(true){
      const part=await reader.read();
      if(part.done)break;
      const chunk=Buffer.from(part.value??[]);
      total+=chunk.byteLength;
      if(total>MAX_BYTES){
        try{await reader.cancel?.('artifact size limit exceeded');}catch{}
        throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact stream exceeds the bounded size limit.');
      }
      chunks.push(chunk);
    }
    if(total<1||(declaredSize!==undefined&&total!==declaredSize)) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact size does not match its declared content length.');
    return Buffer.concat(chunks,total);
  }
  if(declaredSize===undefined) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact response without a stream must declare a bounded content length.');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.byteLength!==declaredSize||bytes.byteLength<1||bytes.byteLength>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact size does not match its declared content length.');
  return bytes;
}
function validPresignedUrl(input:unknown,policy:HttpsTargetPolicy):string{
  try{return requireHttpsUrlForPolicy(String(input??''),'Object storage URL',policy).toString();}
  catch{throw new OperatorError('ARTIFACT_OBJECT_URL_INVALID','Object storage URL violates the configured HTTPS target policy.');}
}
function validDigest(input:unknown):string{const d=String(input??'').toLowerCase();if(!DIGEST.test(d))throw new OperatorError('ARTIFACT_DIGEST_INVALID','Artifact blob digest is invalid.');return d;}
function sha256(bytes:Uint8Array):string{return crypto.createHash('sha256').update(bytes).digest('hex');}
