import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { DevicePoolRequest } from './device-pool.ts';
import { OperatorError } from './errors.ts';

export interface DistributedWorkSpec {
  schemaVersion:1;
  objectiveId:string;
  workUnitId:string;
  projectKey?:string;
  authorityDigest:string;
  requiredCapabilities:string[];
  requiredOs?:'windows'|'linux'|'macos';
  securityClass?:'standard'|'sensitive'|'restricted';
  dataLocalityTags?:string[];
  requiredTags?:string[];
  minMemoryMb?:number;
  requireGpu?:boolean;
  slots?:number;
  leaseMs?:number;
}

export interface DistributedPlacementPlan {
  schemaVersion:1;
  placementKey:string;
  authorityDigest:string;
  devicePoolRequest:DevicePoolRequest;
  isolationTags:string[];
}

export function compileDistributedPlacement(spec:DistributedWorkSpec):DistributedPlacementPlan{
 if(!spec||spec.schemaVersion!==1)throw invalid('Distributed work schemaVersion must be 1.');
 const objectiveId=id(spec.objectiveId,'objectiveId'),workUnitId=id(spec.workUnitId,'workUnitId');
 const authorityDigest=digest(spec.authorityDigest,'authorityDigest');
 const requiredCapabilities=list(spec.requiredCapabilities,256,'requiredCapabilities');
 if(requiredCapabilities.length<1)throw invalid('Distributed work requires at least one capability.');
 const tags=new Set(list(spec.requiredTags??[],64,'requiredTags'));
 const isolationTags:string[]=[];
 if(spec.requiredOs){tags.add(`os:${spec.requiredOs}`);isolationTags.push(`os:${spec.requiredOs}`);}
 if(spec.securityClass){tags.add(`security:${spec.securityClass}`);isolationTags.push(`security:${spec.securityClass}`);}
 for(const tag of list(spec.dataLocalityTags??[],64,'dataLocalityTags')){tags.add(`data:${tag}`);isolationTags.push(`data:${tag}`);}
 const devicePoolRequest:DevicePoolRequest={
  workloadKey:`objective:${objectiveId}/work:${workUnitId}`,
  ...(spec.projectKey?{projectKey:id(spec.projectKey,'projectKey')}:{ }),
  requiredCapabilities,
  requiredTags:[...tags].sort(),
  minMemoryMb:integer(spec.minMemoryMb??0,0,1024*1024,'minMemoryMb'),
  requireGpu:spec.requireGpu===true,
  slots:integer(spec.slots??1,1,64,'slots'),
  leaseMs:integer(spec.leaseMs??5*60_000,10_000,24*60*60_000,'leaseMs')
 };
 const placementKey=crypto.createHash('sha256').update(canonicalJson({objectiveId,workUnitId,authorityDigest,devicePoolRequest}),'utf8').digest('hex');
 return{schemaVersion:1,placementKey,authorityDigest,devicePoolRequest,isolationTags:[...new Set(isolationTags)].sort()};
}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(s))throw invalid(`${l} is invalid.`);return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(`${l} is invalid.`);return s;}
function list(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(`${l} is invalid.`);return[...new Set(v.map(x=>id(x,l)))].sort();}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(`${l} is invalid.`);return n;}
function invalid(m:string):OperatorError{return new OperatorError('DISTRIBUTED_PLACEMENT_INVALID',m);}
