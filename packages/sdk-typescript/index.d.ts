export type AgentGatewayTransport='mcp'|'openai'|'automation'|'local-sdk'|'enterprise-sdk';
export interface GatewayProposal {
  schemaVersion:1; transport:AgentGatewayTransport; principalId:string;
  executionContext:Record<string,unknown>; action:Record<string,unknown>;
  adapterVersion:string; proposedAt:string;
}
export interface MecordGatewayClientOptions {
  baseUrl:string;
  bearerToken:string|(()=>string|Promise<string>);
  fetchImpl?:typeof fetch;
}
export declare class MecordGatewayClient {
  constructor(options:MecordGatewayClientOptions);
  proposal(input:Omit<GatewayProposal,'schemaVersion'|'proposedAt'>&{proposedAt?:string}):GatewayProposal;
  execute(proposal:GatewayProposal):Promise<unknown>;
}
