import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { createCounterfactualTwinManifest, type CounterfactualTwinManifest, type TwinFidelityDimension } from './counterfactual-twin.ts';
import { OperatorError } from './errors.ts';

export interface TwinArtifactDimension {
  artifactIds: string[];
  limitation?: string;
}

export interface CounterfactualTwinReconstructionInput {
  workspaceGraphId: string;
  authorityDigest: string;
  repository: TwinArtifactDimension;
  dependencies: TwinArtifactDimension;
  environment: TwinArtifactDimension;
  services: TwinArtifactDimension;
  database: TwinArtifactDimension;
  browser: TwinArtifactDimension;
  policy: TwinArtifactDimension;
  worldState: TwinArtifactDimension;
  virtualResources?: Record<string,string>;
  createdAt: string;
}

export interface ReconstructedCounterfactualTwin {
  schemaVersion:1;
  id:string;
  manifest:CounterfactualTwinManifest;
  stateDigest:string;
  virtualResources:Record<string,string>;
}

const DIMENSION_ORDER:Array<TwinFidelityDimension['dimension']>=[
  'repository','dependencies','environment','services','database','browser','policy','world-state'
];

export function reconstructCounterfactualTwin(input:CounterfactualTwinReconstructionInput):ReconstructedCounterfactualTwin{
  const dimensions:Record<TwinFidelityDimension['dimension'],TwinArtifactDimension>={
    repository:normalizeDimension(input.repository,'repository'),
    dependencies:normalizeDimension(input.dependencies,'dependencies'),
    environment:normalizeDimension(input.environment,'environment'),
    services:normalizeDimension(input.services,'services'),
    database:normalizeDimension(input.database,'database'),
    browser:normalizeDimension(input.browser,'browser'),
    policy:normalizeDimension(input.policy,'policy'),
    'world-state':normalizeDimension(input.worldState,'world-state')
  };
  const fidelity:TwinFidelityDimension[]=DIMENSION_ORDER.map((dimension)=>{
    const value=dimensions[dimension];
    const modeled=value.artifactIds.length>0;
    return{
      dimension,
      state:modeled?'MODELED':'ABSENT',
      evidenceArtifactIds:value.artifactIds,
      ...(!modeled?{limitation:value.limitation??('No '+dimension+' reconstruction evidence was supplied.')}:{})
    };
  });
  const allArtifactIds=[...new Set(DIMENSION_ORDER.flatMap((dimension)=>dimensions[dimension].artifactIds))].sort();
  const environmentDigest=hash({
    dependencies:dimensions.dependencies.artifactIds,
    environment:dimensions.environment.artifactIds,
    services:dimensions.services.artifactIds,
    database:dimensions.database.artifactIds,
    browser:dimensions.browser.artifactIds
  });
  const manifest=createCounterfactualTwinManifest({
    workspaceGraphId:digest(input.workspaceGraphId,'workspaceGraphId'),
    environmentDigest,
    authorityDigest:digest(input.authorityDigest,'authorityDigest'),
    artifactIds:allArtifactIds,
    fidelity,
    createdAt:iso(input.createdAt,'createdAt')
  });
  const virtualResources=normalizeVirtualResources(input.virtualResources??{});
  const stateDigest=hash({manifestId:manifest.id,virtualResources});
  return{schemaVersion:1,id:hash({manifestId:manifest.id,stateDigest}),manifest,stateDigest,virtualResources};
}

export function twinReconstructionDigest(twin:ReconstructedCounterfactualTwin):string{
  return hash({schemaVersion:twin.schemaVersion,id:twin.id,manifest:twin.manifest,stateDigest:twin.stateDigest,virtualResources:twin.virtualResources});
}

function normalizeDimension(input:TwinArtifactDimension,label:string):TwinArtifactDimension{
  if(!input||typeof input!=='object'||!Array.isArray(input.artifactIds)||input.artifactIds.length>10_000)throw invalid(label+' dimension is invalid.');
  const artifactIds=[...new Set(input.artifactIds.map((value)=>digest(value,label+' artifact id')))].sort();
  const limitation=input.limitation===undefined?undefined:text(input.limitation,4096,label+' limitation');
  if(artifactIds.length===0&&!limitation)throw invalid(label+' dimension must provide evidence or an explicit limitation.');
  return{artifactIds,...(limitation?{limitation}:{})};
}

function normalizeVirtualResources(input:Record<string,string>):Record<string,string>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>100_000)throw invalid('virtualResources are invalid.');
  const entries=Object.entries(input).map(([key,value])=>[resourceKey(key),digest(value,'virtual resource digest')] as const).sort(([a],[b])=>a.localeCompare(b));
  return Object.fromEntries(entries);
}

function resourceKey(v:unknown):string{const s=String(v??'');if(!s||s.length>4096||s.includes('\0'))throw invalid('virtual resource key is invalid.');return s;}
function digest(v:unknown,label:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(label+' is invalid.');return s;}
function iso(v:unknown,label:string):string{const s=String(v??'');if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' is invalid.');return s;}
function text(v:unknown,max:number,label:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max)throw invalid(label+' is invalid.');return v;}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('COUNTERFACTUAL_TWIN_RECONSTRUCTION_INVALID',m);}
