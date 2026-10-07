import fs from 'node:fs/promises';
import path from 'node:path';
import type { OperatorRuntime } from './runtime.ts';
import type { CapabilityPublisherIdentity, SignedCapabilityPackage } from './capability-package-registry.ts';
import type { CapabilityRevocationRecord } from './capability-conformance.ts';
import { CapabilityGovernanceRegistry } from './capability-governance.ts';
import { loadGovernedCapabilityModule } from './capability-extension-loader.ts';
import { OperatorError } from './errors.ts';

export interface CapabilityExtensionConfigV1 {
  version: 1;
  publishers: CapabilityPublisherIdentity[];
  revocations?: CapabilityRevocationRecord[];
  extensions: Array<{
    modulePath: string;
    package: SignedCapabilityPackage;
  }>;
}

export async function loadCapabilityExtensionsFromConfig(input:{
  configPath:string;
  allowedModuleRoots:string[];
  runtime:OperatorRuntime;
}):Promise<{loaded:number;governance:CapabilityGovernanceRegistry}>{
  const configPath=path.resolve(input.configPath);
  const stat=await fs.stat(configPath);
  if(!stat.isFile()||stat.size>8*1024*1024)throw invalid('Capability extension config must be a regular file <= 8 MiB.');
  let raw:unknown;
  try{raw=JSON.parse(await fs.readFile(configPath,'utf8'));}catch{throw invalid('Capability extension config is invalid JSON.');}
  const config=normalizeConfig(raw);
  if(!Array.isArray(input.allowedModuleRoots)||input.allowedModuleRoots.length<1||input.allowedModuleRoots.length>128)throw invalid('Capability extension module roots are required.');
  const governance=new CapabilityGovernanceRegistry();
  for(const publisher of config.publishers)governance.upsertPublisher(publisher);
  for(const revocation of config.revocations??[])governance.importRevocation(revocation);
  let loaded=0;
  for(const extension of config.extensions){
    const modulePath=path.isAbsolute(extension.modulePath)
      ? extension.modulePath
      : path.resolve(path.dirname(configPath),extension.modulePath);
    const provider=await loadGovernedCapabilityModule({
      modulePath,
      allowedRoots:input.allowedModuleRoots,
      package:extension.package,
      governance
    });
    input.runtime.register(provider);
    loaded+=1;
  }
  return{loaded,governance};
}

function normalizeConfig(input:unknown):CapabilityExtensionConfigV1{
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Capability extension config must be an object.');
  const raw=input as CapabilityExtensionConfigV1;
  if(raw.version!==1)throw invalid('Capability extension config version must be 1.');
  if(!Array.isArray(raw.publishers)||raw.publishers.length>10000)throw invalid('Capability publisher config is invalid.');
  if(!Array.isArray(raw.extensions)||raw.extensions.length>1024)throw invalid('Capability extension list is invalid.');
  if(raw.revocations!==undefined&&(!Array.isArray(raw.revocations)||raw.revocations.length>100000))throw invalid('Capability revocation list is invalid.');
  const extensions=raw.extensions.map((entry,index)=>{
    if(!entry||typeof entry!=='object'||typeof entry.modulePath!=='string'||!entry.modulePath.trim()||entry.modulePath.includes('\0'))throw invalid(`extensions[${index}].modulePath is invalid.`);
    if(!entry.package||typeof entry.package!=='object')throw invalid(`extensions[${index}].package is required.`);
    return{modulePath:entry.modulePath,package:structuredClone(entry.package)};
  });
  return{version:1,publishers:structuredClone(raw.publishers),...(raw.revocations?{revocations:structuredClone(raw.revocations)}:{}),extensions};
}
function invalid(message:string):OperatorError{return new OperatorError('CAPABILITY_EXTENSION_CONFIG_INVALID',message);}
