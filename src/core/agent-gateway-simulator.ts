import { normalizeAgentGatewayProposal, type NormalizedAgentGatewayProposal } from './agent-gateway-contract.ts';
import { CapabilityExtensionRegistry, type CapabilityExtensionManifest } from './capability-sdk.ts';
import { OperatorError } from './errors.ts';
import { OperatorRuntime } from './runtime.ts';
import type { ActionResult, CapabilityExecutionContext, CapabilityProvider, PermissionProfile } from './types.ts';

export interface AgentGatewaySimulationResult {
  proposal: NormalizedAgentGatewayProposal;
  result: ActionResult;
  declaredCapability: boolean;
}

export class AgentGatewaySimulator {
  #runtime: OperatorRuntime;
  #manifest: CapabilityExtensionManifest;

  constructor(input:{manifest:CapabilityExtensionManifest;provider:CapabilityProvider}) {
    const registry=new CapabilityExtensionRegistry();
    const bound=registry.register(input.manifest,input.provider);
    this.#manifest=registry.inspect(input.manifest.id)!.manifest;
    this.#runtime=new OperatorRuntime().register(bound);
  }

  async execute(
    proposalInput:unknown,
    permissions:PermissionProfile,
    context:CapabilityExecutionContext={}
  ):Promise<AgentGatewaySimulationResult>{
    const proposal=normalizeAgentGatewayProposal(proposalInput);
    const declaredCapability=this.#manifest.capabilities.some((entry)=>entry.capability===proposal.action.capability);
    if(!declaredCapability) {
      return {
        proposal,
        declaredCapability:false,
        result:{
          ok:false,
          capability:proposal.action.capability,
          provider:'gateway-simulator',
          evidence:[],
          error:{code:'CAPABILITY_EXTENSION_SCOPE_DENIED',message:'Proposal requests a capability not declared by the extension.',retryable:false,sideEffectState:'none',executionPhase:'pre_dispatch'},
          durationMs:0
        }
      };
    }
    const result=await this.#runtime.execute(proposal.action,permissions,context);
    return {proposal,result,declaredCapability:true};
  }

  async close():Promise<void>{
    await this.#runtime.close();
  }
}

export function assertSimulationVerified(result:AgentGatewaySimulationResult):void{
  if(!result.declaredCapability) throw new OperatorError('AGENT_GATEWAY_SIMULATION_FAILED','Capability was not declared.');
  if(!result.result.ok) throw new OperatorError('AGENT_GATEWAY_SIMULATION_FAILED','Simulated execution did not satisfy runtime policy/provider contract.',{details:{code:result.result.error?.code}});
}
