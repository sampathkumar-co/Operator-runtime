import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EnterprisePolicyStore, type EnterpriseAuthorizationContext, type EnterpriseBinding, type EnterpriseRole } from './enterprise-policy.ts';
import type { PermissionProfile } from './types.ts';

export interface EnterprisePolicySimulationCase {
  id:string;
  context:EnterpriseAuthorizationContext;
}
export interface EnterprisePolicySimulationResult {
  id:string;
  allowed:boolean;
  roleIds:string[];
  bindingIds:string[];
  deniedCode?:string;
}
export async function simulateEnterprisePolicy(input:{
  stateDir:string;
  basePermissions:PermissionProfile;
  roles:EnterpriseRole[];
  bindings:EnterpriseBinding[];
  cases:EnterprisePolicySimulationCase[];
}):Promise<EnterprisePolicySimulationResult[]>{
  const root=path.join(path.resolve(input.stateDir),'policy-simulations',crypto.randomUUID());
  const store=new EnterprisePolicyStore(root);
  try{
    await store.configure({roles:input.roles,bindings:input.bindings});
    const out:EnterprisePolicySimulationResult[]=[];
    for(const item of input.cases){
      try{
        const decision=await store.narrow(input.basePermissions,item.context);
        out.push({id:item.id,allowed:true,roleIds:decision.roleIds,bindingIds:decision.bindingIds});
      }catch(error){
        const code=error&&typeof error==='object'&&'code' in error?String((error as {code?:unknown}).code??'DENIED'):'DENIED';
        out.push({id:item.id,allowed:false,roleIds:[],bindingIds:[],deniedCode:code});
      }
    }
    return out;
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
}
