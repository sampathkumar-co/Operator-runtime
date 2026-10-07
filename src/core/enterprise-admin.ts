import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { AuditEvent } from './audit.ts';
import { OperatorError } from './errors.ts';

export interface EnterpriseFleetDevice {
  deviceId:string;
  region:string;
  posture:string[];
  updateChannel:'stable'|'beta'|'canary';
  deploymentMode:'private-vpc'|'on-prem'|'public-relay';
  costCenter:string;
  active:boolean;
}

export interface EnterpriseAdminPolicy {
  allowedRegions:string[];
  requiredPosture:string[];
  allowedDeploymentModes:Array<EnterpriseFleetDevice['deploymentMode']>;
  maxActiveDevices:number;
  monthlyBudget:number;
  monthlyActionQuota:number;
  auditExportEnabled:boolean;
  legalHold:boolean;
}

export interface EnterpriseUsageRecord {
  principalId:string;
  costCenter:string;
  actions:number;
  cost:number;
  at:string;
}

export class EnterpriseAdminControlPlane {
  #policy:EnterpriseAdminPolicy;
  #devices=new Map<string,EnterpriseFleetDevice>();
  #usage:EnterpriseUsageRecord[]=[];

  constructor(policy:EnterpriseAdminPolicy){this.#policy=normalizePolicy(policy);}

  registerDevice(deviceInput:EnterpriseFleetDevice):EnterpriseFleetDevice{
    const device=normalizeDevice(deviceInput);
    if(!this.#policy.allowedRegions.includes(device.region))throw denied('Device region is not allowed.');
    if(!this.#policy.allowedDeploymentModes.includes(device.deploymentMode))throw denied('Deployment mode is not allowed.');
    if(this.#policy.requiredPosture.some((p)=>!device.posture.includes(p)))throw denied('Device posture does not satisfy enterprise policy.');
    const active=[...this.#devices.values()].filter((d)=>d.active&&d.deviceId!==device.deviceId).length;
    if(device.active&&active>=this.#policy.maxActiveDevices)throw denied('Fleet device quota is exhausted.');
    this.#devices.set(device.deviceId,device);
    return structuredClone(device);
  }

  recordUsage(input:EnterpriseUsageRecord):void{
    const record={
      principalId:id(input.principalId,'principalId'),
      costCenter:id(input.costCenter,'costCenter'),
      actions:integer(input.actions,0,1_000_000,'actions'),
      cost:money(input.cost,'cost'),
      at:iso(input.at,'at')
    };
    const month=record.at.slice(0,7);
    const relevant=this.#usage.filter((u)=>u.at.startsWith(month));
    if(relevant.reduce((n,u)=>n+u.actions,0)+record.actions>this.#policy.monthlyActionQuota)throw denied('Monthly action quota would be exceeded.');
    if(relevant.reduce((n,u)=>n+u.cost,0)+record.cost>this.#policy.monthlyBudget)throw denied('Monthly budget would be exceeded.');
    this.#usage.push(record);
  }

  validatePrivateDeployment(deviceIdInput:string):{ok:true;mode:'private-vpc'|'on-prem';region:string}{
    const device=this.#devices.get(id(deviceIdInput,'deviceId'));
    if(!device||!device.active)throw denied('Fleet device is not active.');
    if(device.deploymentMode==='public-relay')throw denied('Private deployment proof requires private-vpc or on-prem mode.');
    return{ok:true,mode:device.deploymentMode,region:device.region};
  }

  chargeback(monthInput:string):Record<string,{actions:number;cost:number}>{
    if(!/^\d{4}-\d{2}$/.test(monthInput))throw invalid('month is invalid.');
    const out:Record<string,{actions:number;cost:number}>={};
    for(const usage of this.#usage.filter((x)=>x.at.startsWith(monthInput))){
      const row=out[usage.costCenter]??{actions:0,cost:0};
      row.actions+=usage.actions;
      row.cost=Math.round((row.cost+usage.cost)*1_000_000)/1_000_000;
      out[usage.costCenter]=row;
    }
    return out;
  }

  exportAudit(eventsInput:AuditEvent[]):{schemaVersion:1;legalHold:boolean;eventCount:number;events:AuditEvent[];digest:string}{
    if(!this.#policy.auditExportEnabled)throw denied('Audit export is disabled.');
    if(!Array.isArray(eventsInput)||eventsInput.length>100_000)throw invalid('audit events are invalid.');
    const events=structuredClone(eventsInput);
    const base={schemaVersion:1 as const,legalHold:this.#policy.legalHold,eventCount:events.length,events};
    const digest=crypto.createHash('sha256').update(canonicalJson(base),'utf8').digest('hex');
    return{...base,digest};
  }

  fleet():EnterpriseFleetDevice[]{
    return[...this.#devices.values()].sort((a,b)=>a.deviceId.localeCompare(b.deviceId)).map((d)=>structuredClone(d));
  }
}

function normalizePolicy(p:EnterpriseAdminPolicy):EnterpriseAdminPolicy{
  if(!p||typeof p!=='object')throw invalid('admin policy is invalid.');
  if(!Array.isArray(p.allowedDeploymentModes)||p.allowedDeploymentModes.some((v)=>!['private-vpc','on-prem','public-relay'].includes(v)))throw invalid('allowedDeploymentModes is invalid.');
  return{
    allowedRegions:list(p.allowedRegions,128,'allowedRegions'),
    requiredPosture:list(p.requiredPosture,128,'requiredPosture'),
    allowedDeploymentModes:[...new Set(p.allowedDeploymentModes)],
    maxActiveDevices:integer(p.maxActiveDevices,1,1_000_000,'maxActiveDevices'),
    monthlyBudget:money(p.monthlyBudget,'monthlyBudget'),
    monthlyActionQuota:integer(p.monthlyActionQuota,1,Number.MAX_SAFE_INTEGER,'monthlyActionQuota'),
    auditExportEnabled:p.auditExportEnabled===true,
    legalHold:p.legalHold===true
  };
}

function normalizeDevice(d:EnterpriseFleetDevice):EnterpriseFleetDevice{
  if(!d||typeof d!=='object'||!['stable','beta','canary'].includes(d.updateChannel)||!['private-vpc','on-prem','public-relay'].includes(d.deploymentMode))throw invalid('fleet device is invalid.');
  return{
    deviceId:id(d.deviceId,'deviceId'),
    region:id(d.region,'region'),
    posture:list(d.posture,128,'posture'),
    updateChannel:d.updateChannel,
    deploymentMode:d.deploymentMode,
    costCenter:id(d.costCenter,'costCenter'),
    active:d.active===true
  };
}

function list(v:unknown,max:number,label:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>id(x,label)))].sort();}
function id(v:unknown,label:string):string{const s=String(v??'');if(!/^[A-Za-z0-9._:@/-]{1,256}$/.test(s))throw invalid(label+' is invalid.');return s;}
function integer(v:unknown,min:number,max:number,label:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid(label+' is invalid.');return n;}
function money(v:unknown,label:string):number{const n=Number(v);if(!Number.isFinite(n)||n<0||n>1_000_000_000)throw invalid(label+' is invalid.');return Math.round(n*1_000_000)/1_000_000;}
function iso(v:unknown,label:string):string{const s=String(v??'');if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw invalid(label+' is invalid.');return s;}
function invalid(m:string):OperatorError{return new OperatorError('ENTERPRISE_ADMIN_INVALID',m);}
function denied(m:string):OperatorError{return new OperatorError('ENTERPRISE_ADMIN_DENIED',m);}
