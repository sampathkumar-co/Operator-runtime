import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { ControlPlaneRecord, ControlPlaneStore } from './control-plane-store.ts';

export interface RelayClusterLease {
  schemaVersion: 1;
  resourceKey: string;
  instanceId: string;
  generation: number;
  fenceToken: string;
  expiresAt: string;
}

const NS='relay-cluster-ownership';

export class RelayClusterCoordinator {
  #store: ControlPlaneStore;
  constructor(store:ControlPlaneStore){this.#store=store;}

  async acquire(resourceKeyInput:string,instanceIdInput:string,leaseMs=30_000,nowInput=new Date().toISOString()):Promise<RelayClusterLease>{
    const resourceKey=id(resourceKeyInput,'resourceKey'), instanceId=id(instanceIdInput,'instanceId');
    const now=iso(nowInput,'now'); const ms=integer(leaseMs,5_000,10*60_000,'leaseMs');
    const current=await this.#store.get(NS,resourceKey);
    const live=current&&(!current.expiresAt||Date.parse(current.expiresAt)>Date.parse(now));
    if(live&&String(current.value.instanceId)!==instanceId){
      throw new OperatorError('RELAY_CLUSTER_RESOURCE_FENCED','Relay resource is owned by another live instance.',{retryable:true,details:{resourceKey,generation:current.generation}});
    }
    const fenceToken=live?String(current!.value.fenceToken):crypto.randomBytes(32).toString('base64url');
    const [record]=await this.#store.transact([{
      namespace:NS,key:resourceKey,expectedGeneration:live?current!.generation:null,
      value:{instanceId,fenceToken},expiresAt:new Date(Date.parse(now)+ms).toISOString()
    }],now);
    return toLease(record!);
  }

  async assertCurrent(leaseInput:RelayClusterLease,nowInput=new Date().toISOString()):Promise<RelayClusterLease>{
    const lease=normalizeLease(leaseInput), now=Date.parse(iso(nowInput,'now'));
    const current=await this.#store.get(NS,lease.resourceKey);
    if(!current||!current.expiresAt||Date.parse(current.expiresAt)<=now) throw new OperatorError('RELAY_CLUSTER_FENCE_LOST','Relay cluster lease expired.');
    const active=toLease(current);
    if(active.instanceId!==lease.instanceId||active.generation!==lease.generation||!sameToken(active.fenceToken,lease.fenceToken)){
      throw new OperatorError('RELAY_CLUSTER_FENCE_STALE','Relay cluster lease is stale.');
    }
    return active;
  }

  async release(leaseInput:RelayClusterLease,nowInput=new Date().toISOString()):Promise<void>{
    const lease=await this.assertCurrent(leaseInput,nowInput);
    await this.#store.transact([{namespace:NS,key:lease.resourceKey,expectedGeneration:lease.generation,value:null}],iso(nowInput,'now'));
  }
}
function toLease(record:ControlPlaneRecord):RelayClusterLease{
  if(!record.expiresAt)throw new OperatorError('RELAY_CLUSTER_STATE_INVALID','Relay cluster record has no expiry.');
  return normalizeLease({schemaVersion:1,resourceKey:record.key,instanceId:String(record.value.instanceId??''),generation:record.generation,fenceToken:String(record.value.fenceToken??''),expiresAt:record.expiresAt});
}
function normalizeLease(input:RelayClusterLease):RelayClusterLease{
  if(!input||input.schemaVersion!==1)throw new OperatorError('RELAY_CLUSTER_STATE_INVALID','Relay cluster lease is invalid.');
  const token=String(input.fenceToken??'');if(!/^[A-Za-z0-9_-]{40,128}$/.test(token))throw new OperatorError('RELAY_CLUSTER_STATE_INVALID','Relay cluster token is invalid.');
  return {schemaVersion:1,resourceKey:id(input.resourceKey,'resourceKey'),instanceId:id(input.instanceId,'instanceId'),generation:integer(input.generation,1,Number.MAX_SAFE_INTEGER,'generation'),fenceToken:token,expiresAt:iso(input.expiresAt,'expiresAt')};
}
function sameToken(a:string,b:string):boolean{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function id(v:unknown,l:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/+=-]{1,256}$/.test(s))throw new OperatorError('RELAY_CLUSTER_STATE_INVALID',l+' is invalid.');return s;}
function iso(v:unknown,l:string):string{const s=String(v??'');if(!s||!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw new OperatorError('RELAY_CLUSTER_STATE_INVALID',l+' must be canonical ISO.');return s;}
function integer(v:unknown,min:number,max:number,l:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw new OperatorError('RELAY_CLUSTER_STATE_INVALID',l+' is invalid.');return n;}
