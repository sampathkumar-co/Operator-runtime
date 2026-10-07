import crypto from 'node:crypto';

export const SDK_VERSION = 1;
export const REQUIRED_CONFORMANCE_SUITES = Object.freeze(['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE']);
export const FIXED_RISKS = Object.freeze(['read','write','external','system','destructive']);
const ID=/^[a-z0-9][a-z0-9._-]{0,127}$/;
const CAP=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST=/^[0-9a-f]{64}$/;

export function canonicalJson(value){return JSON.stringify(canonicalize(value));}
function canonicalize(value){
  if(Array.isArray(value)) return value.map(canonicalize);
  if(!value||typeof value!=='object') return value;
  const out={};
  for(const key of Object.keys(value).sort()){if(value[key]!==undefined)out[key]=canonicalize(value[key]);}
  return out;
}
export function manifestDigest(manifest){
  return crypto.createHash('sha256').update(canonicalJson(validateExtensionManifest(manifest)),'utf8').digest('hex');
}
export function createExtensionManifest(input){return validateExtensionManifest({...input,sdkVersion:SDK_VERSION});}
export function validateExtensionManifest(input){
  if(!input||typeof input!=='object'||input.sdkVersion!==1) throw new TypeError('sdkVersion must be 1');
  const id=bounded(input.id,ID,'id');
  const version=semver(input.version);
  const displayName=text(input.displayName,256,'displayName');
  const vendor=input.vendor===undefined?undefined:text(input.vendor,256,'vendor');
  if(!input.provenance||typeof input.provenance!=='object')throw new TypeError('provenance is required');
  const source=text(input.provenance.source,512,'provenance.source');
  const packageDigest=String(input.provenance.packageDigest??'').toLowerCase();
  if(!DIGEST.test(packageDigest))throw new TypeError('provenance.packageDigest must be SHA-256');
  if(!Array.isArray(input.capabilities)||input.capabilities.length<1||input.capabilities.length>256)throw new TypeError('capabilities must contain 1-256 entries');
  const seen=new Set();
  const capabilities=input.capabilities.map((entry,index)=>{
    if(!entry||typeof entry!=='object')throw new TypeError('capability entry is invalid');
    const capability=bounded(entry.capability,CAP,`capabilities[${index}].capability`);
    if(seen.has(capability))throw new TypeError('capability names must be unique'); seen.add(capability);
    const prefix=`ext.${id}.`;
    if(!capability.startsWith(prefix))throw new TypeError(`new capability must be namespaced under ${prefix}`);
    if(!FIXED_RISKS.includes(entry.risk))throw new TypeError('extension capability risk must be fixed');
    const reconciliation=entry.reconciliation;
    if(!['provider','not-required'].includes(reconciliation))throw new TypeError('reconciliation is invalid');
    if(entry.risk!=='read'&&reconciliation!=='provider')throw new TypeError('mutable capabilities require provider reconciliation');
    if(!['provider','runtime','external'].includes(entry.verification))throw new TypeError('verification is invalid');
    if(entry.inputSchemaVersion!==1||entry.cancellation!=='required')throw new TypeError('schema/cancellation contract is invalid');
    if(typeof entry.deterministic!=='boolean'||typeof entry.reversible!=='boolean')throw new TypeError('deterministic/reversible flags are required');
    const inputMaxBytes=contractBytes(entry.inputMaxBytes,'inputMaxBytes');
    const outputMaxBytes=contractBytes(entry.outputMaxBytes,'outputMaxBytes');
    if(!Array.isArray(entry.resourceKinds)||entry.resourceKinds.length>64)throw new TypeError('resourceKinds is invalid');
    const resourceKinds=[...new Set(entry.resourceKinds.map((v)=>bounded(v,/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,'resourceKind')))].sort();
    if(resourceKinds.length!==entry.resourceKinds.length)throw new TypeError('resourceKinds must be unique');
    return {capability,risk:entry.risk,deterministic:entry.deterministic,reversible:entry.reversible,verification:entry.verification,reconciliation,inputSchemaVersion:1,inputMaxBytes,outputMaxBytes,cancellation:'required',resourceKinds};
  }).sort((a,b)=>a.capability.localeCompare(b.capability));
  return {sdkVersion:1,id,version,displayName,...(vendor?{vendor}:{}),provenance:{source,packageDigest},capabilities};
}
export function createConformancePlan(manifest){
  const m=validateExtensionManifest(manifest);
  return {schemaVersion:1,manifestDigest:manifestDigest(m),extensionId:m.id,extensionVersion:m.version,requiredSuites:[...REQUIRED_CONFORMANCE_SUITES]};
}
export function createGatewayProposal(input){
  if(!input||typeof input!=='object')throw new TypeError('proposal input is invalid');
  const transport=String(input.transport??'');
  if(!['mcp','openai','automation','local-sdk','enterprise-sdk'].includes(transport))throw new TypeError('transport is invalid');
  const principalId=text(input.principalId,256,'principalId');
  const adapterVersion=semver(input.adapterVersion);
  const proposedAt=iso(input.proposedAt);
  if(!input.executionContext||typeof input.executionContext!=='object')throw new TypeError('executionContext is required');
  if(!input.action||typeof input.action!=='object')throw new TypeError('action is required');
  const proposal={schemaVersion:1,transport,principalId,executionContext:structuredClone(input.executionContext),action:structuredClone(input.action),adapterVersion,proposedAt};
  return {...proposal,digest:crypto.createHash('sha256').update(canonicalJson(proposal),'utf8').digest('hex')};
}
function bounded(v,re,label){const s=String(v??'');if(!re.test(s))throw new TypeError(label+' is invalid');return s;}
function text(v,max,label){if(typeof v!=='string'||!v.trim()||v.includes('\0')||Buffer.byteLength(v,'utf8')>max)throw new TypeError(label+' is invalid');return v.trim();}
function semver(v){const s=String(v??'');if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(s))throw new TypeError('version must be SemVer');return s;}
function contractBytes(v,label){const n=Number(v);if(!Number.isSafeInteger(n)||n<1024||n>4194304)throw new TypeError(label+' must be 1024-4194304');return n;}
function iso(v){const s=String(v??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw new TypeError('proposedAt must be canonical ISO');return s;}
