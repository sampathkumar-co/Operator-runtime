import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import {
  normalizeAgentGatewayProposal,
  type AgentGatewayTransport,
  type NormalizedAgentGatewayProposal
} from './agent-gateway-contract.ts';
import { executionContextIdentityFrom, type ExecutionContextIdentity } from './execution-context-identity.ts';
import { OperatorError } from './errors.ts';
import type { ActionRequest } from './types.ts';

export interface AgentGatewayReceipt {
  schemaVersion: 1;
  proposalDigest: string;
  status: 'ACCEPTED' | 'REJECTED' | 'COMPLETED';
  receivedAt: string;
  resultDigest?: string;
  errorCode?: string;
}

export interface AgentGatewayTransportAdapter {
  submit(proposal: NormalizedAgentGatewayProposal): Promise<AgentGatewayReceipt>;
}

export class TrustedAgentGatewayClient {
  #transport: AgentGatewayTransport;
  #principalId: string;
  #adapterVersion: string;
  #clock: () => Date;

  constructor(input: {
    transport: AgentGatewayTransport;
    principalId: string;
    adapterVersion: string;
    clock?: () => Date;
  }) {
    this.#transport = transportName(input.transport);
    this.#principalId = boundedId(input.principalId, 'principalId');
    this.#adapterVersion = semver(input.adapterVersion);
    this.#clock = input.clock ?? (() => new Date());
  }

  propose(action: ActionRequest, executionContext?: ExecutionContextIdentity): NormalizedAgentGatewayProposal {
    const context = executionContext ?? executionContextIdentityFrom({
      ...(action.taskId ? { taskId: action.taskId } : {}),
      actionId: action.id,
      ...(action.intent ? { intent: action.intent } : {})
    });
    return normalizeAgentGatewayProposal({
      schemaVersion: 1,
      transport: this.#transport,
      principalId: this.#principalId,
      executionContext: context,
      action,
      adapterVersion: this.#adapterVersion,
      proposedAt: this.#clock().toISOString()
    });
  }

  async submit(
    action: ActionRequest,
    adapter: AgentGatewayTransportAdapter,
    executionContext?: ExecutionContextIdentity
  ): Promise<{ proposal: NormalizedAgentGatewayProposal; receipt: AgentGatewayReceipt }> {
    if (!adapter || typeof adapter.submit !== 'function') throw invalid('Gateway transport adapter is invalid.');
    const proposal = this.propose(action, executionContext);
    const receipt = normalizeGatewayReceipt(await adapter.submit(proposal));
    if (receipt.proposalDigest !== proposal.digest) {
      throw new OperatorError('AGENT_GATEWAY_RECEIPT_MISMATCH', 'Gateway receipt does not bind the submitted proposal digest.');
    }
    return { proposal, receipt };
  }
}

export function normalizeGatewayReceipt(input: AgentGatewayReceipt): AgentGatewayReceipt {
  if (!input || input.schemaVersion !== 1) throw invalid('Gateway receipt schema is invalid.');
  const proposalDigest = digest(input.proposalDigest, 'proposalDigest');
  if (!['ACCEPTED','REJECTED','COMPLETED'].includes(input.status)) throw invalid('Gateway receipt status is invalid.');
  const receivedAt = iso(input.receivedAt, 'receivedAt');
  const resultDigest = input.resultDigest === undefined ? undefined : digest(input.resultDigest, 'resultDigest');
  const errorCode = input.errorCode === undefined ? undefined : boundedId(input.errorCode, 'errorCode');
  if (input.status === 'COMPLETED' && !resultDigest) throw invalid('Completed gateway receipt requires resultDigest.');
  if (input.status === 'REJECTED' && !errorCode) throw invalid('Rejected gateway receipt requires errorCode.');
  return {
    schemaVersion:1,
    proposalDigest,
    status:input.status,
    receivedAt,
    ...(resultDigest ? { resultDigest } : {}),
    ...(errorCode ? { errorCode } : {})
  };
}

export function gatewayResultDigest(input: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(input),'utf8').digest('hex');
}

function transportName(input: unknown): AgentGatewayTransport {
  if (!['mcp','openai','automation','local-sdk','enterprise-sdk'].includes(String(input ?? ''))) throw invalid('Gateway transport is invalid.');
  return input as AgentGatewayTransport;
}
function boundedId(input: unknown,label:string):string{
  const value=String(input??'');
  if(!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(value)) throw invalid(label+' is invalid.');
  return value;
}
function semver(input: unknown): string {
  const value=String(input??'');
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) throw invalid('adapterVersion must be SemVer.');
  return value;
}
function digest(input:unknown,label:string):string{
  const value=String(input??'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value)) throw invalid(label+' must be SHA-256.');
  return value;
}
function iso(input:unknown,label:string):string{
  const value=String(input??'');
  if(!value||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value) throw invalid(label+' must be canonical ISO.');
  return value;
}
function invalid(message:string):OperatorError{return new OperatorError('AGENT_GATEWAY_SDK_INVALID',message);}
