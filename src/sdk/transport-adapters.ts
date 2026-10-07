import { createAgentGatewayProposal } from '../core/universal-agent-gateway.ts';
import type { AgentGatewayTransport, NormalizedAgentGatewayProposal } from '../core/agent-gateway-contract.ts';
import type { ActionRequest } from '../core/types.ts';
import type { ExecutionContextIdentity } from '../core/execution-context-identity.ts';

export interface GatewayTransportAdapterInput {
  principalId: string;
  executionContext: ExecutionContextIdentity;
  action: ActionRequest;
  proposedAt?: string;
}

export interface GatewayTransportAdapter {
  readonly transport: AgentGatewayTransport;
  readonly adapterVersion: string;
  propose(input: GatewayTransportAdapterInput): NormalizedAgentGatewayProposal;
}

class FixedGatewayTransportAdapter implements GatewayTransportAdapter {
  readonly transport: AgentGatewayTransport;
  readonly adapterVersion: string;

  constructor(transport: AgentGatewayTransport, adapterVersion = '1.0.0') {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(adapterVersion)) {
      throw new Error('Gateway adapter version must be SemVer.');
    }
    this.transport = transport;
    this.adapterVersion = adapterVersion;
  }

  propose(input: GatewayTransportAdapterInput): NormalizedAgentGatewayProposal {
    return createAgentGatewayProposal({
      transport: this.transport,
      principalId: input.principalId,
      executionContext: input.executionContext,
      action: input.action,
      adapterVersion: this.adapterVersion,
      proposedAt: input.proposedAt ?? new Date().toISOString()
    });
  }
}

export function mcpGatewayAdapter(version?: string): GatewayTransportAdapter {
  return new FixedGatewayTransportAdapter('mcp', version);
}
export function openAiGatewayAdapter(version?: string): GatewayTransportAdapter {
  return new FixedGatewayTransportAdapter('openai', version);
}
export function automationGatewayAdapter(version?: string): GatewayTransportAdapter {
  return new FixedGatewayTransportAdapter('automation', version);
}
export function localSdkGatewayAdapter(version?: string): GatewayTransportAdapter {
  return new FixedGatewayTransportAdapter('local-sdk', version);
}
export function enterpriseGatewayAdapter(version?: string): GatewayTransportAdapter {
  return new FixedGatewayTransportAdapter('enterprise-sdk', version);
}
