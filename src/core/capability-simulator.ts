import crypto from 'node:crypto';
import type { ActionRequest, CapabilityProvider } from './types.ts';
import { CapabilityExtensionRegistry, capabilityManifestDigest, type CapabilityExtensionManifest } from './capability-sdk.ts';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface CapabilitySimulationCase {
  id: string;
  action: ActionRequest;
  expected: 'success' | 'failure';
}

export interface CapabilitySimulationReceipt {
  schemaVersion: 1;
  id: string;
  manifestDigest: string;
  providerName: string;
  caseCount: number;
  passed: number;
  failed: number;
  failures: Array<{ caseId:string; code:string }>;
  observedAt: string;
}

export async function simulateCapabilityExtension(input:{
  manifest:CapabilityExtensionManifest;
  provider:CapabilityProvider;
  cases:CapabilitySimulationCase[];
  observedAt?:string;
}):Promise<CapabilitySimulationReceipt>{
  const manifestDigest=capabilityManifestDigest(input.manifest);
  if(!Array.isArray(input.cases)||input.cases.length<1||input.cases.length>10_000)throw invalid('Simulation cases are invalid.');
  const wrapped=new CapabilityExtensionRegistry().register(input.manifest,input.provider);
  const failures:Array<{caseId:string;code:string}>=[];
  let passed=0;
  for(const item of input.cases){
    const caseId=id(item.id,'case.id');
    let actual:'success'|'failure'='failure';
    let code='RESULT_FAILED';
    try{
      if(!await wrapped.supports(item.action)){code='UNSUPPORTED';}
      else{
        const result=await wrapped.execute(item.action,{signal:new AbortController().signal});
        actual=result.ok?'success':'failure';
        code=result.error?.code??(result.ok?'OK':'RESULT_FAILED');
      }
    }catch(error){
      code=typeof (error as any)?.code==='string'?(error as any).code:'THREW';
    }
    if(actual===item.expected)passed+=1;else failures.push({caseId,code});
  }
  const observedAt=iso(input.observedAt??new Date().toISOString());
  const base={schemaVersion:1 as const,manifestDigest,providerName:wrapped.name,caseCount:input.cases.length,passed,failed:failures.length,failures,observedAt};
  return {...base,id:crypto.createHash('sha256').update(canonicalJson(base),'utf8').digest('hex')};
}

export async function runCapabilityAdversarialKit(input:{
  manifest:CapabilityExtensionManifest;
  provider:CapabilityProvider;
}):Promise<{passed:boolean;checks:string[]}>{
  const wrapped=new CapabilityExtensionRegistry().register(input.manifest,input.provider);
  const checks:string[]=[];
  const declared=input.manifest.capabilities[0]!;
  const undeclared:ActionRequest={id:'r6-adversarial-undeclared',capability:'__r6.undeclared__',risk:'read',input:{},provenance:{kind:'runtime'}};
  if(await wrapped.supports(undeclared))throw invalid('Wrapped provider advertised an undeclared capability.');
  checks.push('undeclared-capability-denied');
  const oversized:ActionRequest={id:'r6-adversarial-oversize',capability:declared.capability,risk:declared.risk==='dynamic'?'read':declared.risk,input:{blob:'x'.repeat(declared.inputMaxBytes+1024)},provenance:{kind:'runtime'}};
  try{await wrapped.execute(oversized);throw invalid('Oversized input was accepted.');}
  catch(error){if((error as any)?.code!=='CAPABILITY_EXTENSION_INPUT_TOO_LARGE')throw error;}
  checks.push('oversized-input-denied');
  return {passed:true,checks};
}

function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(s))throw invalid(l+' is invalid.');return s;}
function iso(v:unknown):string{const s=String(v??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid('observedAt must be canonical ISO.');return s;}
function invalid(message:string):OperatorError{return new OperatorError('CAPABILITY_SIMULATOR_INVALID',message);}
