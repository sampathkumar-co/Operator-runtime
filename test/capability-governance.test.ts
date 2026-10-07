import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { capabilityManifestDigest } from '../src/core/capability-sdk.ts';
import { certifyCapabilityExtension, createCapabilityConformanceReceipt } from '../src/core/capability-conformance.ts';
import { signCapabilityPackage } from '../src/core/capability-package-registry.ts';
import { CapabilityGovernanceRegistry } from '../src/core/capability-governance.ts';
import { loadGovernedCapabilityModule } from '../src/core/capability-extension-loader.ts';
import { projectCapabilityQuality } from '../src/core/capability-quality.ts';
import { capabilityRiskRule } from '../src/core/capability-policy.ts';

function makeReceipts(manifest:any){
  const digest=capabilityManifestDigest(manifest);
  return ['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE'].map((suite,index)=>createCapabilityConformanceReceipt({
    suite:suite as any,manifestDigest:digest,verifierId:'independent:r6',independent:true,passed:true,
    evidenceArtifactIds:[String(index+1).repeat(64)],observedAt:'2026-10-07T00:00:00.000Z',
    ...(suite==='PERFORMANCE'?{metrics:{p95LatencyMs:5,failureRate:0,peakMemoryMb:16}}:{})
  }));
}

test('digest-bound module loads only after strict governance and live revocation disables it without restart',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-cap-module-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleText=`export function createCapabilityProvider(){return {name:'third-party-probe',supports:a=>a.capability==='file.read',score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),async execute(a){return {ok:true,capability:a.capability,provider:'third-party-probe',output:{thirdParty:true,moduleUrl:import.meta.url},evidence:[],durationMs:1}}}}`;
  const modulePath=path.join(root,'provider.mjs');await fs.writeFile(modulePath,moduleText);
  const packageDigest=crypto.createHash('sha256').update(moduleText).digest('hex');
  const manifest={sdkVersion:1 as const,id:'external.files',version:'1.0.0',displayName:'External Files',provenance:{source:'file:provider.mjs',packageDigest},capabilities:[{capability:'file.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]};
  const receipts=makeReceipts(manifest);
  const certification=certifyCapabilityExtension({manifest,receipts,certifiedAt:'2026-10-07T00:01:00.000Z'});
  const keys=crypto.generateKeyPairSync('ed25519');
  const pkg=signCapabilityPackage({
    publisherId:'publisher:r6',manifest,certification,publishedAt:'2026-10-07T00:02:00.000Z',
    privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    build:{sourceDigest:'a'.repeat(64),buildRecipeDigest:'b'.repeat(64),builderId:'builder:r6',builtAt:'2026-10-07T00:01:30.000Z',reproducible:true},
    lifecycle:{vulnerabilityChannel:'https://security.example.com/report'}
  });
  const governance=new CapabilityGovernanceRegistry();
  governance.upsertPublisher({id:'publisher:r6',displayName:'R6 Publisher',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),enabled:true});

  // Deterministically replace the pathname after the loader reads the signed
  // bytes but before a pathname-based import could reopen it. The executed
  // provider must still come from the exact bytes whose digest was verified.
  const originalReadFile=fs.readFile.bind(fs);
  const maliciousModuleText=`export function createCapabilityProvider(){return {name:'third-party-probe',supports:()=>true,score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),async execute(a){return {ok:true,capability:a.capability,provider:'third-party-probe',output:{thirdParty:false,maliciousReplacement:true,moduleUrl:import.meta.url},evidence:[],durationMs:1}}}}`;
  let swapped=false;
  (fs as any).readFile=async (...args:any[])=>{
    const bytes=await (originalReadFile as any)(...args);
    if(!swapped&&path.resolve(String(args[0]))===path.resolve(modulePath)){
      swapped=true;
      await fs.writeFile(modulePath,maliciousModuleText);
    }
    return bytes;
  };
  let provider:any;
  try{provider=await loadGovernedCapabilityModule({modulePath,allowedRoots:[root],package:pkg,governance});}
  finally{(fs as any).readFile=originalReadFile;}
  assert.equal(swapped,true);
  const action={id:'read',capability:'file.read',risk:'read' as const,input:{},provenance:{kind:'runtime' as const}};
  const firstResult=await provider.execute(action);
  assert.equal(firstResult.ok,true);
  assert.equal((firstResult.output as any)?.thirdParty,true);
  assert.equal((firstResult.output as any)?.maliciousReplacement,undefined);
  assert.match(String((firstResult.output as any)?.moduleUrl),/^data:text\/javascript;base64,/);
  governance.revokePackage(pkg,{reasonCode:'VULNERABILITY_CONFIRMED',evidenceArtifactIds:['f'.repeat(64)],revokedAt:'2026-10-07T00:03:00.000Z'});
  assert.equal(await provider.supports(action),false);
  await assert.rejects(()=>provider.execute(action),(e:any)=>e?.code==='CAPABILITY_PACKAGE_REVOKED');
});

test('strict live governance rejects packages lacking reproducible build and lifecycle metadata',()=>{
  const manifest={sdkVersion:1 as const,id:'external.bad',version:'1.0.0',displayName:'Bad',provenance:{source:'test',packageDigest:'c'.repeat(64)},capabilities:[{capability:'file.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]};
  const certification=certifyCapabilityExtension({manifest,receipts:makeReceipts(manifest),certifiedAt:'2026-10-07T00:01:00.000Z'});
  const keys=crypto.generateKeyPairSync('ed25519');
  const pkg=signCapabilityPackage({publisherId:'publisher:bad',manifest,certification,publishedAt:'2026-10-07T00:02:00.000Z',privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()});
  const governance=new CapabilityGovernanceRegistry();governance.upsertPublisher({id:'publisher:bad',displayName:'Bad',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),enabled:true});
  assert.equal(governance.currentAdmission(pkg).reason,'BUILD_METADATA_MISSING');
  assert.throws(()=>governance.wrap(pkg,{name:'x',supports:()=>true,score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),async execute(a){return{ok:true,capability:a.capability,provider:'x',evidence:[],durationMs:1}}}),(e:any)=>e?.code==='CAPABILITY_PACKAGE_NOT_ADMITTED');
});

test('quality badge derives from certification and verified runtime receipts',()=>{
  const manifest={sdkVersion:1 as const,id:'quality.files',version:'1.0.0',displayName:'Quality',provenance:{source:'test',packageDigest:'d'.repeat(64)},capabilities:[{capability:'file.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]};
  const receipts=makeReceipts(manifest);const certification=certifyCapabilityExtension({manifest,receipts,certifiedAt:'2026-10-07T00:01:00.000Z'});
  const quality=projectCapabilityQuality({certification,conformanceReceipts:receipts,runtimeObservations:Array.from({length:20},()=>({verified:true,failed:false,latencyMs:5}))});
  assert.equal(quality.badge,'verified');assert.equal(quality.verifiedRate,1);assert.match(quality.digest,/^[0-9a-f]{64}$/);
});


test('failed governed module load releases namespaced risk authority',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-cap-leak-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleText="export default () => ({name:'leak-probe',supports:()=>true,score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),async execute(a){return {ok:true,capability:a.capability,provider:'leak-probe',evidence:[],durationMs:1}}})";
  const modulePath=path.join(root,'provider.mjs');await fs.writeFile(modulePath,moduleText);
  const manifest={sdkVersion:1 as const,id:'leak.probe',version:'1.0.0',displayName:'Leak Probe',provenance:{source:'file:provider.mjs',packageDigest:'e'.repeat(64)},capabilities:[{capability:'ext.leak.probe.read',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]};
  const certification=certifyCapabilityExtension({manifest,receipts:makeReceipts(manifest),certifiedAt:'2026-10-07T00:01:00.000Z'});
  const keys=crypto.generateKeyPairSync('ed25519');
  const pkg=signCapabilityPackage({
    publisherId:'publisher:leak',manifest,certification,publishedAt:'2026-10-07T00:02:00.000Z',
    privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    build:{sourceDigest:'a'.repeat(64),buildRecipeDigest:'b'.repeat(64),builderId:'builder:leak',builtAt:'2026-10-07T00:01:30.000Z',reproducible:true},
    lifecycle:{vulnerabilityChannel:'mailto:security@example.com'}
  });
  const governance=new CapabilityGovernanceRegistry();
  governance.upsertPublisher({id:'publisher:leak',displayName:'Leak Publisher',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),enabled:true});
  await assert.rejects(
    ()=>loadGovernedCapabilityModule({modulePath,allowedRoots:[root],package:pkg,governance}),
    (e:any)=>e?.code==='CAPABILITY_MODULE_DIGEST_MISMATCH'
  );
  assert.throws(()=>capabilityRiskRule('ext.leak.probe.read'),(e:any)=>e?.code==='CAPABILITY_RISK_UNREGISTERED');
});
