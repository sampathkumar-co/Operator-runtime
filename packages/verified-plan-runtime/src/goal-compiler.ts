import type { CompiledGoal, GoalConstraint } from './contracts.ts';

export interface GoalDraft {
  id: string;
  kind: string;
  objective: string;
  successFactKeys: string[];
  forbiddenFactKeys?: string[];
  constraints?: GoalConstraint[];
  unresolvedAssumptions?: string[];
}

export function compileGoal(input: GoalDraft): CompiledGoal {
  if (!input || typeof input !== 'object') throw new Error('goal draft is required.');
  const success = unique(input.successFactKeys?.map((v) => bounded(v, 512, 'successFactKey')) ?? []);
  if (success.length === 0 || success.length > 1000) throw new Error('goal requires 1-1000 success facts.');
  const forbidden = unique((input.forbiddenFactKeys ?? []).map((v) => bounded(v, 512, 'forbiddenFactKey')));
  const overlap = success.filter((key) => forbidden.includes(key));
  if (overlap.length) throw new Error('goal facts cannot be both required and forbidden: ' + overlap.join(', '));

  const constraints = (input.constraints ?? []).map(normalizeConstraint);
  const ids = new Set<string>();
  for (const item of constraints) {
    if (ids.has(item.id)) throw new Error('constraint ids must be unique.');
    ids.add(item.id);
  }

  const mustByFact = new Map<string, Set<string | undefined>>();
  const mustNotByFact = new Map<string, Set<string | undefined>>();
  for (const constraint of constraints) {
    if (constraint.strength === 'MUST') {
      const values=mustByFact.get(constraint.factKey)??new Set<string|undefined>();
      values.add(constraint.expectedValueDigest);
      mustByFact.set(constraint.factKey,values);
    }
    if (constraint.strength === 'MUST_NOT') {
      const values=mustNotByFact.get(constraint.factKey)??new Set<string|undefined>();
      values.add(constraint.expectedValueDigest);
      mustNotByFact.set(constraint.factKey,values);
    }
  }
  for(const [factKey,values] of mustByFact){
    const concrete=[...values].filter((value):value is string=>value!==undefined);
    if(new Set(concrete).size>1) throw new Error('conflicting MUST values for fact: '+factKey);
  }
  for (const [factKey, mustValues] of mustByFact) {
    const deniedValues=mustNotByFact.get(factKey);
    if (!deniedValues) continue;
    const mustAny=[...mustValues];
    const denyAny=[...deniedValues];
    const contradiction=
      mustAny.includes(undefined) ||
      denyAny.includes(undefined) ||
      mustAny.some((value)=>value!==undefined&&denyAny.includes(value));
    if (contradiction) throw new Error('contradictory hard constraints for fact: ' + factKey);
  }
  for(const constraint of constraints){
    if(constraint.strength==='MUST_NOT'&&success.includes(constraint.factKey)&&constraint.expectedValueDigest===undefined){
      throw new Error('hard MUST_NOT constraint contradicts required success fact: '+constraint.factKey);
    }
    if(constraint.strength==='MUST'&&forbidden.includes(constraint.factKey)&&constraint.expectedValueDigest===undefined){
      throw new Error('hard MUST constraint contradicts forbidden goal fact: '+constraint.factKey);
    }
  }

  return {
    id: bounded(input.id, 256, 'goal.id'),
    kind: bounded(input.kind, 256, 'goal.kind'),
    objective: bounded(input.objective, 16_384, 'goal.objective'),
    successFactKeys: success,
    forbiddenFactKeys: forbidden,
    constraints,
    unresolvedAssumptions: unique((input.unresolvedAssumptions ?? []).map((v) => bounded(v, 2048, 'assumption')))
  };
}

function normalizeConstraint(input: GoalConstraint): GoalConstraint {
  if (!input || typeof input !== 'object') throw new Error('constraint is required.');
  const strengths = new Set(['MUST','SHOULD','MAY','MUST_NOT']);
  if (!strengths.has(input.strength)) throw new Error('constraint.strength is invalid.');
  return {
    id: bounded(input.id, 256, 'constraint.id'),
    strength: input.strength,
    factKey: bounded(input.factKey, 512, 'constraint.factKey'),
    ...(input.expectedValueDigest ? { expectedValueDigest: sha256(input.expectedValueDigest, 'constraint.expectedValueDigest') } : {}),
    description: bounded(input.description, 2048, 'constraint.description')
  };
}
function unique(values:string[]):string[]{ return [...new Set(values)].sort(); }
function bounded(input:unknown,max:number,label:string):string{
  if(typeof input!=='string'||!input||input.length>max) throw new Error(label+' is invalid.');
  return input;
}
function sha256(input:unknown,label:string):string{
  if(typeof input!=='string'||!/^[0-9a-fA-F]{64}$/.test(input)) throw new Error(label+' must be SHA-256.');
  return input.toLowerCase();
}
