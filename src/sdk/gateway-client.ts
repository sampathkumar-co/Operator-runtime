import { createAgentGatewayProposal, type UniversalAgentGateway } from '../core/universal-agent-gateway.ts';
import type { AgentGatewayProposalV1, AgentGatewayTransport } from '../core/agent-gateway-contract.ts';
import type { ActionRequest } from '../core/types.ts';
import type { ExecutionContextIdentity } from '../core/execution-context-identity.ts';

export interface GatewayHttpClientOptions {
  baseUrl: string;
  bearerToken: string | (() => string | Promise<string>);
  fetchImpl?: typeof fetch;
}

export class MecordGatewayClient {
  #baseUrl: URL;
  #token: GatewayHttpClientOptions['bearerToken'];
  #fetch: typeof fetch;

  constructor(options: GatewayHttpClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (!['https:','http:'].includes(this.#baseUrl.protocol)) throw new Error('Gateway baseUrl must use HTTP(S).');
    if (this.#baseUrl.protocol === 'http:' && !['localhost','127.0.0.1','::1'].includes(this.#baseUrl.hostname)) {
      throw new Error('Plain HTTP gateway clients are restricted to loopback.');
    }
    this.#token = options.bearerToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  proposal(input: {
    transport: AgentGatewayTransport;
    principalId: string;
    executionContext: ExecutionContextIdentity;
    action: ActionRequest;
    adapterVersion: string;
    proposedAt?: string;
  }) {
    return createAgentGatewayProposal({
      ...input,
      proposedAt: input.proposedAt ?? new Date().toISOString()
    });
  }

  async execute(proposal: AgentGatewayProposalV1): Promise<unknown> {
    const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
    if (token.length < 16) throw new Error('Gateway bearer token is invalid.');
    const url = new URL('/v1/gateway/execute', this.#baseUrl);
    const response = await this.#fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(proposal)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Gateway rejected request with HTTP ${response.status}.`);
    return body;
  }
}

export type { UniversalAgentGateway };
