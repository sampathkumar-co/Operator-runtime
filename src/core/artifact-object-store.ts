import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';

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

  constructor(urls: ArtifactObjectUrlProvider, fetchImpl: ArtifactFetch = globalThis.fetch as unknown as ArtifactFetch) {
    if (!urls || typeof urls.putUrl !== 'function' || typeof urls.getUrl !== 'function') {
      throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID','Object URL provider is invalid.');
    }
    if (typeof fetchImpl !== 'function') throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID','Object fetch implementation is invalid.');
    this.#urls=urls; this.#fetch=fetchImpl;
  }

  async put(digestInput:string,bytesInput:Uint8Array):Promise<void>{
    const digest=validDigest(digestInput);
    const bytes=Buffer.from(bytesInput);
    if(bytes.byteLength<1||bytes.byteLength>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact size is invalid.');
    if(sha256(bytes)!==digest) throw new OperatorError('ARTIFACT_INTEGRITY_FAILED','Object artifact bytes do not match their content address.');
    const url=validPresignedUrl(await this.#urls.putUrl({digest,bytes:bytes.byteLength}));
    const response=await this.#fetch(url,{
      method:'PUT',redirect:'error',body:bytes,
      headers:{'content-type':'application/octet-stream','content-length':String(bytes.byteLength),'x-mecord-sha256':digest}
    });
    if(!response.ok) throw new OperatorError('ARTIFACT_OBJECT_STORE_WRITE_FAILED',`Object store PUT failed with HTTP ${response.status}.`,{retryable:response.status>=500});
  }

  async get(digestInput:string):Promise<Buffer>{
    const digest=validDigest(digestInput);
    const url=validPresignedUrl(await this.#urls.getUrl({digest}));
    const response=await this.#fetch(url,{method:'GET',redirect:'error'});
    if(!response.ok) throw new OperatorError('ARTIFACT_OBJECT_STORE_READ_FAILED',`Object store GET failed with HTTP ${response.status}.`,{retryable:response.status>=500});
    const declared=response.headers.get('content-length');
    if(declared!==null){
      const size=Number(declared);
      if(!Number.isSafeInteger(size)||size<1||size>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact content length is invalid.');
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.byteLength<1||bytes.byteLength>MAX_BYTES) throw new OperatorError('ARTIFACT_SIZE_INVALID','Object artifact size is invalid.');
    if(sha256(bytes)!==digest) throw new OperatorError('ARTIFACT_INTEGRITY_FAILED','Object artifact download failed digest verification.');
    return bytes;
  }
}

function validPresignedUrl(input:unknown):string{
  let url:URL; try{url=new URL(String(input??''));}catch{throw new OperatorError('ARTIFACT_OBJECT_URL_INVALID','Object storage URL is invalid.');}
  if(url.protocol!=='https:'||url.username||url.password) throw new OperatorError('ARTIFACT_OBJECT_URL_INVALID','Object storage URL must use HTTPS and must not contain URL credentials.');
  if(url.hash) throw new OperatorError('ARTIFACT_OBJECT_URL_INVALID','Object storage URL must not contain a fragment.');
  return url.toString();
}
function validDigest(input:unknown):string{const d=String(input??'').toLowerCase();if(!DIGEST.test(d))throw new OperatorError('ARTIFACT_DIGEST_INVALID','Artifact blob digest is invalid.');return d;}
function sha256(bytes:Uint8Array):string{return crypto.createHash('sha256').update(bytes).digest('hex');}
