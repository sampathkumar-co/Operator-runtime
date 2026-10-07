import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type TwinFidelityState = 'MODELED' | 'PARTIAL' | 'ABSENT';

export interface TwinFidelityDimension {
  dimension: 'repository' | 'dependencies' | 'environment' | 'services' | 'database' | 'browser' | 'policy' | 'world-state';
  state: TwinFidelityState;
  evidenceArtifactIds: string[];
  limitation?: string;
}

export interface CounterfactualTwinManifest {
  schemaVersion: 1;
  id: string;
  workspaceGraphId: string;
  environmentDigest: string;
  authorityDigest: string;
  artifactIds: string[];
  fidelity: TwinFidelityDimension[];
  createdAt: string;
}

const DIMENSIONS= new Set<TwinFidelityDimension['dimension']>(['repository','dependencies','environment','services','database','browser','policy','world-state']);
const STATES=new Set<TwinFidelityState>(['MODELED','PARTIAL','ABSENT']);
const DIGEST=/^[0-9a-f]{64}$/;

export function createCounterfactualTwinManifest(input:Omit<CounterfactualTwinManifest,'schemaVersion'|'id'>):CounterfactualTwinManifest{
  const workspaceGraphId=digest(input.workspaceGraphId,'workspaceGraphId');
  const environmentDigest=digest(input.environmentDigest,'environmentDigest');
  const authorityDigest=digest(input.authorityDigest,'authorityDigest');
  const artifactIds=digests(input.artifactIds,'artifactIds');
  const createdAt=iso(input.createdAt,'createdAt');
  if(!Array.isArray(input.fidelity)||input.fidelity.length<1||input.fidelity.length>DIMENSIONS.size) throw invalid('Twin fidelity dimensions are invalid.');
  const seen=new Set<string>();
  const fidelity=input.fidelity.map((f)=>{
    if(!f||!DIMENSIONS.has(f.dimension)||!STATES.has(f.state)||seen.has(f.dimension)) throw invalid('Twin fidelity dimension is invalid or duplicated.');
    seen.add(f.dimension);
    const evidenceArtifactIds=digests(f.evidenceArtifactIds,`fidelity.${f.dimension}.evidenceArtifactIds`);
    if(f.state==='MODELED'&&evidenceArtifactIds.length<1) throw invalid(`MODELED twin dimension ${f.dimension} requires evidence.`);
    const limitation=f.limitation===undefined?undefined:text(f.limitation,4096,'limitation');
    if(f.state!=='MODELED'&&!limitation) throw invalid(`${f.state} twin dimension ${f.dimension} requires an explicit limitation.`);
    return {dimension:f.dimension,state:f.state,evidenceArtifactIds,...(limitation?{limitation}:{})};
  }).sort((a,b)=>a.dimension.localeCompare(b.dimension));
  const identity={schemaVersion:1 as const,workspaceGraphId,environmentDigest,authorityDigest,artifactIds,fidelity,createdAt};
  const id=crypto.createHash('sha256').update(canonicalJson(identity),'utf8').digest('hex');
  return {...identity,id};
}

export function twinSupportsClaim(manifest:CounterfactualTwinManifest, requiredDimensions:TwinFidelityDimension['dimension'][]):{
  supported:boolean; missing:string[]; partial:string[];
}{
  const map=new Map(manifest.fidelity.map(f=>[f.dimension,f]));
  const missing:string[]=[]; const partial:string[]=[];
  for(const dimension of [...new Set(requiredDimensions)]){
    const state=map.get(dimension)?.state??'ABSENT';
    if(state==='ABSENT')missing.push(dimension);
    if(state==='PARTIAL')partial.push(dimension);
  }
  return {supported:missing.length===0&&partial.length===0,missing,partial};
}

function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!DIGEST.test(s))throw invalid(`${l} is invalid.`);return s;}
function digests(v:unknown,l:string):string[]{if(!Array.isArray(v)||v.length>5000)throw invalid(`${l} is invalid.`);return [...new Set(v.map(x=>digest(x,l)))].sort();}
function iso(v:unknown,l:string):string{const s=String(v??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(`${l} must be canonical ISO.`);return s;}
function text(v:unknown,max:number,l:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max)throw invalid(`${l} is invalid.`);return v;}
function invalid(m:string):OperatorError{return new OperatorError('COUNTERFACTUAL_TWIN_INVALID',m);}
