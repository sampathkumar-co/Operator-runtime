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
export interface GatewayTransportAdapterInput {
  principalId:string;
  executionContext:Record<string,unknown>;
  action:Record<string,unknown>;
  proposedAt?:string;
}
export interface GatewayTransportAdapter {
  readonly transport:AgentGatewayTransport;
  readonly adapterVersion:string;
  propose(input:GatewayTransportAdapterInput):GatewayProposal;
}
export declare const mcpGatewayAdapter:(version?:string)=>GatewayTransportAdapter;
export declare const openAiGatewayAdapter:(version?:string)=>GatewayTransportAdapter;
export declare const automationGatewayAdapter:(version?:string)=>GatewayTransportAdapter;
export declare const localSdkGatewayAdapter:(version?:string)=>GatewayTransportAdapter;
export declare const enterpriseGatewayAdapter:(version?:string)=>GatewayTransportAdapter;

export type GatewayEventKind='operation.started'|'operation.completed'|'operation.failed'|'capability.certified'|'capability.revoked'|'device.changed';
export interface GatewayWebhookSubscription {
  schemaVersion:1; id:string; endpoint:string; eventKinds:GatewayEventKind[]; enabled:boolean; createdAt:string;
}
export declare function gatewayWebhookSubscription(input:{id:string;endpoint:string;eventKinds:GatewayEventKind[];enabled?:boolean;createdAt?:string}):GatewayWebhookSubscription;
export declare class MecordWebhookVerifier {
  constructor(secret:string);
  verify(body:string,signature:string):Promise<Record<string,unknown>>;
}
