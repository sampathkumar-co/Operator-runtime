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
  const ids = new Set<string>();
  for (const node of nodesInput) {
    if (ids.has(node.id)) throw new Error('hypothesis node ids must be unique.');
    ids.add(node.id);
  }

  const now = (options.now ?? new Date()).getTime();
  const policy: HypothesisRetentionPolicy = {
    maxTotal: integer(policyInput.maxTotal ?? 5000, 1, 100000, 'maxTotal'),
    maxPerScope: integer(policyInput.maxPerScope ?? 1500, 1, 100000, 'maxPerScope'),
    preserveStates: policyInput.preserveStates ?? ['ACTIVE','SUPPORTED','BLOCKED'],
    resolvedTtlMs: integer(policyInput.resolvedTtlMs ?? 24*60*60_000, 0, Number.MAX_SAFE_INTEGER, 'resolvedTtlMs'),
    disprovenTtlMs: integer(policyInput.disprovenTtlMs ?? 6*60*60_000, 0, Number.MAX_SAFE_INTEGER, 'disprovenTtlMs')
  };

  const reasonById: Record<string,string> = {};
  const sourceById = new Map(nodesInput.map((node) => [node.id, node]));
  const eligible = nodesInput.filter((node) => {
    const updated = Date.parse(node.updatedAt);
    if (!Number.isFinite(updated)) {
      reasonById[node.id] = 'invalid-updated-at';
      return false;
    }
    const age = Math.max(0, now - updated);
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
  const initial: HypothesisNode[] = [];
  for (const node of [...eligible].sort((a,b)=>priority(b)-priority(a)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id))) {
    const count = keptByScope.get(node.scope) ?? 0;
    if (count >= policy.maxPerScope) {
      reasonById[node.id] = 'scope-cap';
      continue;
    }
    if (initial.length >= policy.maxTotal) {
      reasonById[node.id] = 'global-cap';
      continue;
    }
    initial.push(structuredClone(node));
    keptByScope.set(node.scope, count+1);
  }

  // A retained snapshot must be internally referentially complete. If a live
  // dependency/parent is removed by TTL/cap pruning, the dependent node is
  // removed too. References to terminal RESOLVED/DISPROVEN nodes may be
  // safely elided because they are no longer unresolved prerequisites.
  const retainedById = new Map(initial.map((node) => [node.id, node]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of [...retainedById.entries()]) {
      const missingParent = node.parentId && !retainedById.has(node.parentId);
      if (missingParent) {
        const originalParent = sourceById.get(node.parentId!);
        if (!originalParent || !isTerminal(originalParent)) {
          retainedById.delete(id);
          reasonById[id] = originalParent ? 'parent-pruned' : 'dangling-parent';
          changed = true;
          continue;
        }
        delete node.parentId;
      }

      const nextDependencies: string[] = [];
      let invalidDependency = false;
      for (const dependency of node.dependsOn ?? []) {
        if (retainedById.has(dependency)) {
          nextDependencies.push(dependency);
          continue;
        }
        const original = sourceById.get(dependency);
        if (original && isTerminal(original)) continue;
        invalidDependency = true;
        reasonById[id] = original ? 'dependency-pruned' : 'dangling-dependency';
        break;
      }
      if (invalidDependency) {
        retainedById.delete(id);
        changed = true;
        continue;
      }
      if (node.dependsOn) {
        if (nextDependencies.length > 0) node.dependsOn = [...new Set(nextDependencies)].sort();
        else delete node.dependsOn;
      }
    }
  }

  const retained = [...retainedById.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const retainedIds = new Set(retained.map((node)=>node.id));
  const prunedIds = nodesInput.map((node)=>node.id).filter((id)=>!retainedIds.has(id)).sort();
  return {retained,prunedIds,reasonById};
}

function isTerminal(node: HypothesisNode): boolean {
  return node.state === 'RESOLVED' || node.state === 'DISPROVEN';
}

function integer(input: unknown,min:number,max:number,label:string):number{
  const value=Number(input);
  if(!Number.isSafeInteger(value)||value<min||value>max) throw new Error(label+' is invalid.');
  return value;
}
