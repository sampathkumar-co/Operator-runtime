import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { normalizeExecutionContextIdentity, type ExecutionContextIdentity } from './execution-context-identity.ts';
import { OperatorError } from './errors.ts';
import type { ActionRequest } from './types.ts';

export type AgentGatewayTransport = 'mcp' | 'openai' | 'automation' | 'local-sdk' | 'enterprise-sdk';

export interface AgentGatewayProposalV1 {
  schemaVersion: 1;
  transport: AgentGatewayTransport;
  principalId: string;
  executionContext: ExecutionContextIdentity;
  action: ActionRequest;
  adapterVersion: string;
  proposedAt: string;
}

export interface NormalizedAgentGatewayProposal extends AgentGatewayProposalV1 {
  digest: string;
}

/**
 * Transport adapters may propose actions, but this envelope never authorizes them.
 * Dispatch must still pass canonical runtime intent/authority/policy/lease checks.
 */
export function normalizeAgentGatewayProposal(input: unknown): NormalizedAgentGatewayProposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Agent gateway proposal must be an object.');
  const raw = structuredClone(input) as AgentGatewayProposalV1;
  if (raw.schemaVersion !== 1) throw invalid('Agent gateway proposal schemaVersion must be 1.');
  if (!['mcp','openai','automation','local-sdk','enterprise-sdk'].includes(raw.transport)) throw invalid('Agent gateway transport is invalid.');
  const principalId = boundedId(raw.principalId, 'principalId');
  const adapterVersion = semver(raw.adapterVersion);
  const proposedAt = canonicalIso(raw.proposedAt);
  const executionContext = normalizeExecutionContextIdentity(raw.executionContext);
  const action = normalizeAction(raw.action);
  if (executionContext.actionId && executionContext.actionId !== action.id) {
    throw invalid('Execution context actionId must match the proposed action identity.');
  }
  if (executionContext.taskId && action.taskId && executionContext.taskId !== action.taskId) {
    throw invalid('Execution context taskId must match the proposed action taskId.');
  }
  if (executionContext.conversationId && action.intent) {
    if (
      executionContext.conversationId !== action.intent.conversationId ||
      executionContext.intentVersion !== action.intent.intentVersion ||
      executionContext.intentDigest !== action.intent.digest
    ) throw invalid('Execution context intent lineage must match the proposed action.');
  }
  const normalized: AgentGatewayProposalV1 = {
    schemaVersion: 1,
    transport: raw.transport,
    principalId,
    executionContext,
    action,
    adapterVersion,
    proposedAt
  };
  return {
    ...normalized,
    digest: crypto.createHash('sha256').update(canonicalJson(normalized),'utf8').digest('hex')
  };
}

function normalizeAction(input: unknown): ActionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Agent gateway action is invalid.');
  const raw = input as ActionRequest;
  const id = boundedId(raw.id, 'action.id');
  const capability = boundedId(raw.capability, 'action.capability');
  if (!['read','write','external','system','destructive'].includes(raw.risk)) throw invalid('Agent gateway action risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw invalid('Agent gateway action input is invalid.');
  if (!raw.provenance || !['user','chatgpt','trusted_policy','runtime','website','file','application','terminal'].includes(raw.provenance.kind)) {
    throw invalid('Agent gateway action provenance is invalid.');
  }
  return structuredClone({ ...raw, id, capability });
}
function boundedId(input: unknown,label:string):string{
  if(typeof input!=='string'||!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(input)) throw invalid(`${label} is invalid.`);
  return input;
}
function semver(input:unknown):string{
  const v=String(input??'');
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)) throw invalid('adapterVersion must be SemVer.');
  return v;
}
function canonicalIso(input:unknown):string{
  const v=String(input??'');
  if(!v||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v) throw invalid('proposedAt must be canonical ISO.');
  return v;
}
function invalid(message:string):OperatorError{return new OperatorError('AGENT_GATEWAY_PROPOSAL_INVALID',message);}
