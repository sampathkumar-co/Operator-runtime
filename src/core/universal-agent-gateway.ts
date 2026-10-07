import type { ActionResult, PermissionProfile, CapabilityExecutionContext } from './types.ts';
import { normalizeAgentGatewayProposal, type AgentGatewayProposalV1, type NormalizedAgentGatewayProposal } from './agent-gateway-contract.ts';
import { OperatorError } from './errors.ts';

export interface TrustedGatewayExecutor {
  execute(
    action: NormalizedAgentGatewayProposal['action'],
    permissions: PermissionProfile,
    context?: CapabilityExecutionContext
  ): Promise<ActionResult>;
}

export interface AgentGatewayPrincipalAuthorizer {
  permissionsFor(principalId: string, proposal: NormalizedAgentGatewayProposal): Promise<PermissionProfile> | PermissionProfile;
}

export interface AgentGatewayExecutionReceipt {
  schemaVersion: 1;
  proposalDigest: string;
  principalId: string;
  transport: NormalizedAgentGatewayProposal['transport'];
  actionId: string;
  result: ActionResult;
  completedAt: string;
}

export class UniversalAgentGateway {
  #executor: TrustedGatewayExecutor;
  #authorizer: AgentGatewayPrincipalAuthorizer;

  constructor(input: { executor: TrustedGatewayExecutor; authorizer: AgentGatewayPrincipalAuthorizer }) {
    this.#executor = input.executor;
    this.#authorizer = input.authorizer;
  }

  normalize(input: unknown): NormalizedAgentGatewayProposal {
    return normalizeAgentGatewayProposal(input);
  }

  async execute(input: unknown): Promise<AgentGatewayExecutionReceipt> {
    const proposal = this.normalize(input);
    const permissions = await this.#authorizer.permissionsFor(proposal.principalId, proposal);
    return await this.executeAuthorized(proposal, permissions);
  }

  async executeAuthorized(
    input: unknown,
    permissions: PermissionProfile,
    expectedPrincipalId?: string
  ): Promise<AgentGatewayExecutionReceipt> {
    const proposal = 'digest' in (input as any)
      ? input as NormalizedAgentGatewayProposal
      : this.normalize(input);
    if (expectedPrincipalId !== undefined && proposal.principalId !== expectedPrincipalId) {
      throw new OperatorError('AGENT_GATEWAY_PRINCIPAL_MISMATCH', 'Gateway proposal principal does not match the authenticated request principal.');
    }
    assertPermissions(permissions);
    const result = await this.#executor.execute(proposal.action, permissions, {
      learningContext: `gateway:${proposal.principalId}`
    });
    return {
      schemaVersion: 1,
      proposalDigest: proposal.digest,
      principalId: proposal.principalId,
      transport: proposal.transport,
      actionId: proposal.action.id,
      result,
      completedAt: new Date().toISOString()
    };
  }
}

export function createAgentGatewayProposal(input: Omit<AgentGatewayProposalV1, 'schemaVersion'>): NormalizedAgentGatewayProposal {
  return normalizeAgentGatewayProposal({ schemaVersion: 1, ...input });
}

function assertPermissions(input: PermissionProfile): void {
  if (!input || !Array.isArray(input.allowedCapabilities) || !Array.isArray(input.allowedRoots)) {
    throw new OperatorError('AGENT_GATEWAY_AUTHORITY_INVALID', 'Gateway principal authorizer returned an invalid permission profile.');
  }
}
