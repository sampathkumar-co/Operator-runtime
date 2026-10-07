import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { CapabilityCertification, CapabilityConformanceReceipt } from './capability-conformance.ts';
import { validateCapabilityCertification, validateCapabilityConformanceReceipt } from './capability-conformance.ts';
import { OperatorError } from './errors.ts';

export interface CapabilityRuntimeObservation {
  verified: boolean;
  failed: boolean;
  latencyMs: number;
}

export interface CapabilityQualityProjection {
  schemaVersion: 1;
  certificationId: string;
  receiptCount: number;
  independentReceiptRate: number;
  runtimeObservationCount: number;
  verifiedRate: number;
  failureRate: number;
  p95LatencyMs: number;
  reliabilityScore: number;
  badge: 'verified'|'provisional'|'degraded';
  digest: string;
}

export function projectCapabilityQuality(input:{
  certification:CapabilityCertification;
  conformanceReceipts:CapabilityConformanceReceipt[];
  runtimeObservations:CapabilityRuntimeObservation[];
}):CapabilityQualityProjection{
  const certification=validateCapabilityCertification(input.certification);
  const receipts=input.conformanceReceipts.map(validateCapabilityConformanceReceipt);
  if(receipts.some(r=>r.manifestDigest!==certification.manifestDigest))throw invalid('Conformance receipt does not belong to certification manifest.');
  if(input.runtimeObservations.length>1_000_000)throw invalid('Runtime observation collection is too large.');
  const observations=input.runtimeObservations.map((o,i)=>{
    if(!o||typeof o.verified!=='boolean'||typeof o.failed!=='boolean'||!Number.isFinite(o.latencyMs)||o.latencyMs<0||o.latencyMs>24*60*60_000)throw invalid(`Runtime observation ${i} is invalid.`);
    return o;
  });
  const independentReceiptRate=receipts.length===0?0:receipts.filter(r=>r.independent&&r.passed).length/receipts.length;
  const verifiedRate=observations.length===0?0:observations.filter(o=>o.verified).length/observations.length;
  const failureRate=observations.length===0?0:observations.filter(o=>o.failed).length/observations.length;
  const latencies=observations.map(o=>o.latencyMs).sort((a,b)=>a-b);
  const p95LatencyMs=latencies.length===0?0:latencies[Math.min(latencies.length-1,Math.max(0,Math.ceil(latencies.length*.95)-1))]!;
  const reliabilityScore=clamp(
    .35*(certification.status==='CERTIFIED'?1:0)+
    .20*independentReceiptRate+
    .35*verifiedRate+
    .10*(1-failureRate)
  );
  const badge:CapabilityQualityProjection['badge']=
    certification.status==='CERTIFIED'&&observations.length>=10&&reliabilityScore>=.95?'verified':
    reliabilityScore>=.75?'provisional':'degraded';
  const base={
    schemaVersion:1 as const,certificationId:certification.id,receiptCount:receipts.length,
    independentReceiptRate,runtimeObservationCount:observations.length,verifiedRate,failureRate,p95LatencyMs,reliabilityScore,badge
  };
  return {...base,digest:crypto.createHash('sha256').update(canonicalJson(base),'utf8').digest('hex')};
}
function clamp(v:number):number{return Math.max(0,Math.min(1,v));}
function invalid(message:string):OperatorError{return new OperatorError('CAPABILITY_QUALITY_INVALID',message);}
