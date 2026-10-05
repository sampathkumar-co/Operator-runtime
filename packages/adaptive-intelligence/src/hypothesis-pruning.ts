import type { HypothesisNode, HypothesisScope } from './hypothesis-graph.ts';

export interface HypothesisRetentionPolicy {
  maxTotal: number;
  maxPerScope: number;
  preserveStates?: Array<'ACTIVE'|'SUPPORTED'|'BLOCKED'>;
  resolvedTtlMs?: number;
  disprovenTtlMs?: number;
}

export interface HypothesisPruneResult {
  retained: HypothesisNode[];
  prunedIds: string[];
  reasonById: Record<string,string>;
}

export function pruneHypotheses(
  nodesInput: HypothesisNode[],
  policyInput: Partial<HypothesisRetentionPolicy> = {},
  options: { now?: Date } = {}
): HypothesisPruneResult {
  if (!Array.isArray(nodesInput) || nodesInput.length > 100_000) throw new Error('hypothesis nodes are invalid.');
  const now = (options.now ?? new Date()).getTime();
  const policy: HypothesisRetentionPolicy = {
    maxTotal: integer(policyInput.maxTotal ?? 5000, 1, 100000, 'maxTotal'),
    maxPerScope: integer(policyInput.maxPerScope ?? 1500, 1, 100000, 'maxPerScope'),
    preserveStates: policyInput.preserveStates ?? ['ACTIVE','SUPPORTED','BLOCKED'],
    resolvedTtlMs: integer(policyInput.resolvedTtlMs ?? 24*60*60_000, 0, Number.MAX_SAFE_INTEGER, 'resolvedTtlMs'),
    disprovenTtlMs: integer(policyInput.disprovenTtlMs ?? 6*60*60_000, 0, Number.MAX_SAFE_INTEGER, 'disprovenTtlMs')
  };

  const reasonById: Record<string,string> = {};
  const eligible = nodesInput.filter((node) => {
    const age = Math.max(0, now - Date.parse(node.updatedAt));
    if (node.state === 'RESOLVED' && age > policy.resolvedTtlMs!) {
      reasonById[node.id] = 'resolved-expired';
      return false;
    }
    if (node.state === 'DISPROVEN' && age > policy.disprovenTtlMs!) {
      reasonById[node.id] = 'disproven-expired';
      return false;
    }
    return true;
  });

  const priority = (node: HypothesisNode): number => {
    const preserved = policy.preserveStates!.includes(node.state as 'ACTIVE'|'SUPPORTED'|'BLOCKED') ? 1000 : 0;
    const scopeWeight: Record<HypothesisScope,number> = {task:50,subgoal:40,environment:30,action:20,target:10};
    const freshness = Math.max(0, 100 - Math.floor((now - Date.parse(node.updatedAt))/60_000));
    return preserved + node.confidence*100 + scopeWeight[node.scope] + freshness;
  };

  const keptByScope = new Map<HypothesisScope,number>();
  const retained: HypothesisNode[] = [];
  for (const node of [...eligible].sort((a,b)=>priority(b)-priority(a)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id))) {
    const count = keptByScope.get(node.scope) ?? 0;
    if (count >= policy.maxPerScope) {
      reasonById[node.id] = 'scope-cap';
      continue;
    }
    if (retained.length >= policy.maxTotal) {
      reasonById[node.id] = 'global-cap';
      continue;
    }
    retained.push(structuredClone(node));
    keptByScope.set(node.scope, count+1);
  }

  retained.sort((a,b)=>a.id.localeCompare(b.id));
  const retainedIds = new Set(retained.map((node)=>node.id));
  const prunedIds = nodesInput.map((node)=>node.id).filter((id)=>!retainedIds.has(id)).sort();
  return {retained,prunedIds,reasonById};
}

function integer(input: unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
