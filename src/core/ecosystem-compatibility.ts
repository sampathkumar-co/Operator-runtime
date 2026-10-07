import type { AgentGatewayTransport } from './agent-gateway-contract.ts';
import { OperatorError } from './errors.ts';

export interface EcosystemCompatibilityEntry {
  integration: 'mcp'|'openai-agents'|'automation-webhook'|'typescript-sdk'|'python-sdk'|'enterprise-agent';
  transport: AgentGatewayTransport;
  gatewaySchemaVersion: 1;
  capabilitySdkVersion: 1;
  minimumAdapterVersion: string;
  status: 'supported'|'experimental';
}

export const R6_COMPATIBILITY_MATRIX: readonly EcosystemCompatibilityEntry[] = Object.freeze([
  {integration:'mcp',transport:'mcp',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'},
  {integration:'openai-agents',transport:'openai',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'},
  {integration:'automation-webhook',transport:'automation',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'},
  {integration:'typescript-sdk',transport:'local-sdk',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'},
  {integration:'python-sdk',transport:'local-sdk',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'},
  {integration:'enterprise-agent',transport:'enterprise-sdk',gatewaySchemaVersion:1,capabilitySdkVersion:1,minimumAdapterVersion:'1.0.0',status:'supported'}
]);

export function assertEcosystemCompatible(input:{
  integration:EcosystemCompatibilityEntry['integration'];
  gatewaySchemaVersion:number;
  capabilitySdkVersion:number;
  adapterVersion:string;
}):EcosystemCompatibilityEntry{
  const entry=R6_COMPATIBILITY_MATRIX.find(item=>item.integration===input.integration);
  if(!entry)throw invalid('Integration is not registered.');
  if(input.gatewaySchemaVersion!==entry.gatewaySchemaVersion||input.capabilitySdkVersion!==entry.capabilitySdkVersion)throw invalid('Integration contract version is incompatible.');
  if(compareSemver(input.adapterVersion,entry.minimumAdapterVersion)<0)throw invalid('Adapter version is below the supported minimum.');
  return entry;
}
function compareSemver(a:string,b:string):number{
  const parse=(v:string)=>{const m=v.match(/^(\d+)\.(\d+)\.(\d+)/);if(!m)throw invalid('Adapter version must be SemVer.');return m.slice(1).map(Number);};
  const aa=parse(a),bb=parse(b);for(let i=0;i<3;i++){if(aa[i]!==bb[i])return aa[i]!>bb[i]!?1:-1;}return 0;
}
function invalid(message:string):OperatorError{return new OperatorError('ECOSYSTEM_COMPATIBILITY_INVALID',message);}
