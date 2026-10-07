import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnterprisePolicyStore, type EnterpriseBinding, type EnterpriseRole } from './enterprise-policy.ts';
import { evaluateEnterprisePolicyLanguage, type EnterprisePolicyEvaluationContext, type EnterprisePolicyRule } from './enterprise-policy-language.ts';
import type { PermissionProfile } from './types.ts';

export interface EnterpriseHistoricalAction {
  id: string;
  originalAllowed: boolean;
  basePermissions: PermissionProfile;
  authorizationContext: {
    principalId: string;
    teamIds?: string[];
    projectKey?: string;
    environment?: string;
    deviceId?: string;
    deviceGroups?: string[];
  };
  policyContext: EnterprisePolicyEvaluationContext;
}

export interface EnterpriseHistoricalPolicyDelta {
  id: string;
  originalAllowed: boolean;
  proposedAllowed: boolean;
  changed: boolean;
  reasons: string[];
}

export async function simulatePolicyAgainstHistory(input:{
  roles:EnterpriseRole[];
  bindings:EnterpriseBinding[];
  rules:EnterprisePolicyRule[];
  actions:EnterpriseHistoricalAction[];
}):Promise<{examined:number;changed:number;wouldAllow:number;wouldDeny:number;deltas:EnterpriseHistoricalPolicyDelta[]}>{
  if(!Array.isArray(input.actions)||input.actions.length>10_000)throw new Error('Historical action set is invalid.');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mecord-enterprise-policy-history-'));
  try{
    const store=new EnterprisePolicyStore(root);
    await store.configure({roles:input.roles,bindings:input.bindings});
    const deltas:EnterpriseHistoricalPolicyDelta[]=[];
    for(const action of input.actions){
      let canonicalAllowed=false;
      const reasons:string[]=[];
      try{await store.narrow(action.basePermissions,action.authorizationContext);canonicalAllowed=true;}
      catch(error){reasons.push(error instanceof Error?error.message:String(error));}
      const advanced=evaluateEnterprisePolicyLanguage(input.rules,action.policyContext);
      const proposedAllowed=canonicalAllowed&&advanced.allowed;
      reasons.push(...advanced.reasons);
      deltas.push({id:action.id,originalAllowed:action.originalAllowed,proposedAllowed,changed:proposedAllowed!==action.originalAllowed,reasons});
    }
    return{
      examined:deltas.length,
      changed:deltas.filter((d)=>d.changed).length,
      wouldAllow:deltas.filter((d)=>d.proposedAllowed).length,
      wouldDeny:deltas.filter((d)=>!d.proposedAllowed).length,
      deltas
    };
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
}
