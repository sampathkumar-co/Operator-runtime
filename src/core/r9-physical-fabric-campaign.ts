import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface R9PhysicalMachineEvidence {
  machineId: string;
  physicalMachine: boolean;
  platform: 'windows' | 'linux' | 'macos';
  hardwareAttestationDigest: string;
  runtimeInstanceId: string;
  sourceCheckoutSha: string;
  evidenceDigests: string[];
}

export interface R9DistributedFaultEvidence {
  fault:
    | 'worker-disconnect'
    | 'worker-crash'
    | 'worker-replacement'
    | 'lease-expiry'
    | 'resource-conflict'
    | 'control-plane-restart'
    | 'stale-result'
    | 'network-partition'
    | 'duplicate-delivery';
  exercised: boolean;
  recovered: boolean;
  splitBrainCount: number;
  duplicateExecutionCount: number;
  authorityViolationCount: number;
  evidenceLossCount: number;
  evidenceDigests: string[];
}

export interface R9PhysicalFabricCampaignBody {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  objectiveId: string;
  authorityDigest: string;
  machines: R9PhysicalMachineEvidence[];
  workerCount: number;
  workUnitCount: number;
  verifiedWorkUnitCount: number;
  independentVerifierCount: number;
  crossMachineVerificationCount: number;
  lineageCoverageRate: number;
  artifactRecoveryRate: number;
  artifactOnlyExchange: boolean;
  rawSecretExchangeCount: number;
  leaseEpochMonotonic: boolean;
  staleResultAcceptedCount: number;
  unfencedResourceConflictCount: number;
  faultEvidence: R9DistributedFaultEvidence[];
  finalObjectiveVerified: boolean;
  externalEvidenceDigests: string[];
}

export interface R9PhysicalFabricCampaign {
  body: R9PhysicalFabricCampaignBody;
  digest: string;
}

export interface R9PhysicalFabricReport {
  schemaVersion: 1;
  sourceSha: string;
  campaignId: string;
  physicalMachineCount: number;
  distinctPlatformCount: number;
  verifiedWorkUnitRate: number;
  lineageCoverageRate: number;
  artifactRecoveryRate: number;
  allRequiredFaultsPassed: boolean;
  splitBrainCount: number;
  duplicateExecutionCount: number;
  authorityViolationCount: number;
  evidenceLossCount: number;
  status: 'CERTIFIED' | 'NOT_CERTIFIED';
  reasons: string[];
  campaignDigest: string;
  reportDigest: string;
}

const REQUIRED_FAULTS:R9DistributedFaultEvidence['fault'][]=[
  'worker-disconnect','worker-crash','worker-replacement','lease-expiry',
  'resource-conflict','control-plane-restart','stale-result','network-partition','duplicate-delivery'
];

export function createR9PhysicalFabricCampaign(input:R9PhysicalFabricCampaignBody):R9PhysicalFabricCampaign{
  const body=normalize(input);
  return {body,digest:hash(body)};
}
export function verifyR9PhysicalFabricCampaign(input:R9PhysicalFabricCampaign):boolean{
  try{return digest(input.digest,'campaign digest')===hash(normalize(input.body));}catch{return false;}
}
export function certifyR9PhysicalFabricCampaign(input:R9PhysicalFabricCampaign):R9PhysicalFabricReport{
  if(!verifyR9PhysicalFabricCampaign(input))throw invalid('Physical fabric campaign digest verification failed.');
  const b=normalize(input.body),reasons:string[]=[];
  const physical=b.machines.filter((machine)=>machine.physicalMachine);
  const platforms=new Set(physical.map((machine)=>machine.platform));
  if(physical.length<2)reasons.push('fewer than two physical machines participated');
  if(new Set(physical.map((machine)=>machine.machineId)).size<2)reasons.push('physical machine identities are not distinct');
  if(b.workerCount<2)reasons.push('fewer than two distributed workers participated');
  if(b.workUnitCount<20)reasons.push('fewer than 20 distributed work units were exercised');
  const verifiedWorkUnitRate=rate(b.verifiedWorkUnitCount,b.workUnitCount);
  if(verifiedWorkUnitRate!==1)reasons.push('not every work unit reached independent verified completion');
  if(b.independentVerifierCount<1)reasons.push('no independent verifier participated');
  if(b.crossMachineVerificationCount!==b.verifiedWorkUnitCount)reasons.push('not every verified work unit was independently checked on another physical machine');
  if(b.lineageCoverageRate!==1)reasons.push('distributed lineage coverage was below 100%');
  if(b.artifactRecoveryRate!==1)reasons.push('artifact recovery coverage was below 100%');
  if(!b.artifactOnlyExchange)reasons.push('distributed exchange was not artifact-only');
  if(b.rawSecretExchangeCount!==0)reasons.push('raw secret exchange occurred between workers');
  if(!b.leaseEpochMonotonic)reasons.push('lease epochs were not monotonic across replacement/recovery');
  if(b.staleResultAcceptedCount!==0)reasons.push('a stale distributed result was accepted');
  if(b.unfencedResourceConflictCount!==0)reasons.push('a resource conflict escaped fencing');
  if(!b.finalObjectiveVerified)reasons.push('final distributed objective did not independently verify');
  if(b.externalEvidenceDigests.length<3)reasons.push('insufficient cross-machine evidence artifacts');
  for(const machine of physical){
    if(machine.sourceCheckoutSha!==b.sourceSha)reasons.push('physical machine '+machine.machineId+' did not run the certification source SHA');
    if(machine.evidenceDigests.length<1)reasons.push('physical machine '+machine.machineId+' has no machine evidence artifact');
  }

  const faultMap=new Map(b.faultEvidence.map((item)=>[item.fault,item]));
  let allRequiredFaultsPassed=true;
  let splitBrainCount=0,duplicateExecutionCount=0,authorityViolationCount=0,evidenceLossCount=0;
  for(const fault of REQUIRED_FAULTS){
    const item=faultMap.get(fault);
    if(!item||!item.exercised||!item.recovered||item.evidenceDigests.length<1){
      allRequiredFaultsPassed=false;
      reasons.push('required distributed fault campaign incomplete: '+fault);
      continue;
    }
    splitBrainCount+=item.splitBrainCount;
    duplicateExecutionCount+=item.duplicateExecutionCount;
    authorityViolationCount+=item.authorityViolationCount;
    evidenceLossCount+=item.evidenceLossCount;
  }
  if(splitBrainCount!==0)reasons.push('split-brain execution occurred');
  if(duplicateExecutionCount!==0)reasons.push('duplicate execution occurred');
  if(authorityViolationCount!==0)reasons.push('authority dilution/violation occurred');
  if(evidenceLossCount!==0)reasons.push('evidence loss occurred');
  if(!allRequiredFaultsPassed)reasons.push('not all distributed fault classes passed');

  const base={
    schemaVersion:1 as const,sourceSha:b.sourceSha,campaignId:b.campaignId,physicalMachineCount:physical.length,
    distinctPlatformCount:platforms.size,verifiedWorkUnitRate,lineageCoverageRate:b.lineageCoverageRate,
    artifactRecoveryRate:b.artifactRecoveryRate,allRequiredFaultsPassed,splitBrainCount,duplicateExecutionCount,
    authorityViolationCount,evidenceLossCount,status:reasons.length===0?'CERTIFIED' as const:'NOT_CERTIFIED' as const,
    reasons:[...new Set(reasons)],campaignDigest:input.digest
  };
  return {...base,reportDigest:hash(base)};
}

function normalize(input:R9PhysicalFabricCampaignBody):R9PhysicalFabricCampaignBody{
  if(!input||input.schemaVersion!==1)throw invalid('Campaign schemaVersion must be 1.');
  if(!Array.isArray(input.machines)||input.machines.length>1000)throw invalid('Machines are invalid.');
  const machineIds=new Set<string>(),runtimeIds=new Set<string>();
  const machines=input.machines.map((machine)=>{
    const value=normalizeMachine(machine);
    if(machineIds.has(value.machineId)||runtimeIds.has(value.runtimeInstanceId))throw invalid('Machine/runtime identities must be unique.');
    machineIds.add(value.machineId);runtimeIds.add(value.runtimeInstanceId);return value;
  });
  if(!Array.isArray(input.faultEvidence)||input.faultEvidence.length>100)throw invalid('Fault evidence is invalid.');
  const faults=new Set<string>();
  const faultEvidence=input.faultEvidence.map((item)=>{
    const value=normalizeFault(item);
    if(faults.has(value.fault))throw invalid('Fault classes must be unique.');
    faults.add(value.fault);return value;
  });
  return{
    schemaVersion:1,sourceSha:gitSha(input.sourceSha,'sourceSha'),campaignId:id(input.campaignId,'campaignId'),
    objectiveId:id(input.objectiveId,'objectiveId'),authorityDigest:digest(input.authorityDigest,'authorityDigest'),
    machines,workerCount:integer(input.workerCount,0,100_000,'workerCount'),workUnitCount:integer(input.workUnitCount,1,10_000_000,'workUnitCount'),
    verifiedWorkUnitCount:integer(input.verifiedWorkUnitCount,0,input.workUnitCount,'verifiedWorkUnitCount'),
    independentVerifierCount:integer(input.independentVerifierCount,0,100_000,'independentVerifierCount'),
    crossMachineVerificationCount:integer(input.crossMachineVerificationCount,0,input.workUnitCount,'crossMachineVerificationCount'),
    lineageCoverageRate:probability(input.lineageCoverageRate,'lineageCoverageRate'),artifactRecoveryRate:probability(input.artifactRecoveryRate,'artifactRecoveryRate'),
    artifactOnlyExchange:bool(input.artifactOnlyExchange,'artifactOnlyExchange'),rawSecretExchangeCount:integer(input.rawSecretExchangeCount,0,1_000_000,'rawSecretExchangeCount'),
    leaseEpochMonotonic:bool(input.leaseEpochMonotonic,'leaseEpochMonotonic'),staleResultAcceptedCount:integer(input.staleResultAcceptedCount,0,1_000_000,'staleResultAcceptedCount'),
    unfencedResourceConflictCount:integer(input.unfencedResourceConflictCount,0,1_000_000,'unfencedResourceConflictCount'),
    faultEvidence,finalObjectiveVerified:bool(input.finalObjectiveVerified,'finalObjectiveVerified'),
    externalEvidenceDigests:digestList(input.externalEvidenceDigests,10_000,'externalEvidenceDigests')
  };
}
function normalizeMachine(input:R9PhysicalMachineEvidence):R9PhysicalMachineEvidence{
  const platform=String(input.platform??'') as R9PhysicalMachineEvidence['platform'];
  if(!['windows','linux','macos'].includes(platform))throw invalid('Machine platform is invalid.');
  return{machineId:id(input.machineId,'machineId'),physicalMachine:bool(input.physicalMachine,'physicalMachine'),platform,
    hardwareAttestationDigest:digest(input.hardwareAttestationDigest,'hardwareAttestationDigest'),runtimeInstanceId:id(input.runtimeInstanceId,'runtimeInstanceId'),sourceCheckoutSha:gitSha(input.sourceCheckoutSha,'sourceCheckoutSha'),evidenceDigests:digestList(input.evidenceDigests,1000,'machine.evidenceDigests')};
}
function normalizeFault(input:R9DistributedFaultEvidence):R9DistributedFaultEvidence{
  if(!REQUIRED_FAULTS.includes(input.fault))throw invalid('Fault class is invalid.');
  return{fault:input.fault,exercised:bool(input.exercised,'fault.exercised'),recovered:bool(input.recovered,'fault.recovered'),
    splitBrainCount:integer(input.splitBrainCount,0,1_000_000,'splitBrainCount'),duplicateExecutionCount:integer(input.duplicateExecutionCount,0,1_000_000,'duplicateExecutionCount'),
    authorityViolationCount:integer(input.authorityViolationCount,0,1_000_000,'authorityViolationCount'),evidenceLossCount:integer(input.evidenceLossCount,0,1_000_000,'evidenceLossCount'),
    evidenceDigests:digestList(input.evidenceDigests,1000,'fault.evidenceDigests')};
}
function bool(v:unknown,l:string):boolean{if(typeof v!=='boolean')throw invalid(l+' is invalid.');return v;}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(l+' is invalid.');return n;}
function probability(v:unknown,l:string):number{const n=Number(v);if(!Number.isFinite(n)||n<0||n>1)throw invalid(l+' is invalid.');return n;}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+-]{1,512}$/.test(s))throw invalid(l+' is invalid.');return s;}
function gitSha(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{40}$/.test(s))throw invalid(l+' must be git SHA.');return s;}
function digest(v:unknown,l:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{64}$/.test(s))throw invalid(l+' must be SHA-256.');return s;}
function digestList(v:unknown,max:number,l:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(l+' is invalid.');return[...new Set(v.map((x)=>digest(x,l)))].sort();}
function rate(n:number,d:number):number{return d===0?0:Math.round((n/d)*1_000_000)/1_000_000;}
function hash(v:unknown):string{return crypto.createHash('sha256').update(canonicalJson(v),'utf8').digest('hex');}
function invalid(m:string):OperatorError{return new OperatorError('R9_PHYSICAL_FABRIC_INVALID',m);}
