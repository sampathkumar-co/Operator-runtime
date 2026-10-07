import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperatorRuntime } from '../src/core/runtime.ts';
import { capabilityManifestDigest } from '../src/core/capability-sdk.ts';
import { createCapabilityConformanceReceipt, certifyCapabilityExtension } from '../src/core/capability-conformance.ts';
import { signCapabilityPackage } from '../src/core/capability-package-registry.ts';
import { loadCapabilityExtensionsFromConfig } from '../src/core/capability-extension-config.ts';

function receipts(manifest:any){
  const digest=capabilityManifestDigest(manifest);
  return ['SANDBOX','CONTRACT','ADVERSARIAL','PERFORMANCE'].map((suite,index)=>createCapabilityConformanceReceipt({
    suite:suite as any,manifestDigest:digest,verifierId:'r6-config-verifier',independent:true,passed:true,
    evidenceArtifactIds:[String(index+1).repeat(64)],observedAt:'2026-10-07T00:00:00.000Z',
    ...(suite==='PERFORMANCE'?{metrics:{p95LatencyMs:1,failureRate:0,peakMemoryMb:8}}:{})
  }));
}

test('third-party provider loads from config without core changes and live publisher disable revokes it',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'r6-extension-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const moduleText=`export function createCapabilityProvider(){return {name:'configured-third-party',supports:a=>a.capability==='ext.configured.files.echo',score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),async execute(a){return {ok:true,capability:a.capability,provider:'configured-third-party',output:{configured:true},evidence:[],durationMs:1}}}}`;
  const modulePath=path.join(root,'extension.mjs');await fs.writeFile(modulePath,moduleText);
  const manifest={sdkVersion:1 as const,id:'configured.files',version:'1.0.0',displayName:'Configured Files',provenance:{source:'file:extension.mjs',packageDigest:crypto.createHash('sha256').update(moduleText).digest('hex')},capabilities:[{capability:'ext.configured.files.echo',risk:'read' as const,deterministic:true,reversible:true,verification:'runtime' as const,reconciliation:'not-required' as const,inputSchemaVersion:1 as const,inputMaxBytes:4096,outputMaxBytes:4096,cancellation:'required' as const,resourceKinds:['file']}]};
  const cert=certifyCapabilityExtension({manifest,receipts:receipts(manifest),certifiedAt:'2026-10-07T00:01:00.000Z'});
  const keys=crypto.generateKeyPairSync('ed25519');
  const pkg=signCapabilityPackage({
    publisherId:'publisher:configured',manifest,certification:cert,publishedAt:'2026-10-07T00:02:00.000Z',
    privateKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),
    build:{sourceDigest:'a'.repeat(64),buildRecipeDigest:'b'.repeat(64),builderId:'builder:configured',builtAt:'2026-10-07T00:01:30.000Z',reproducible:true},
    lifecycle:{vulnerabilityChannel:'mailto:security@example.com'}
  });
  const publisher={id:'publisher:configured',displayName:'Configured Publisher',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),enabled:true};
  const configPath=path.join(root,'extensions.json');
  await fs.writeFile(configPath,JSON.stringify({version:1,publishers:[publisher],extensions:[{modulePath:'extension.mjs',package:pkg}]},null,2));
  const runtime=new OperatorRuntime();
  const loaded=await loadCapabilityExtensionsFromConfig({configPath,allowedModuleRoots:[root],runtime});
  assert.equal(loaded.loaded,1);
  await runtime.initialize();
  assert.deepEqual(await runtime.supportedCapabilities(['ext.configured.files.echo']),['ext.configured.files.echo']);
  const result=await runtime.execute({id:'configured-read',capability:'ext.configured.files.echo',risk:'read',input:{},provenance:{kind:'runtime'}},{allowedCapabilities:['ext.*'],allowedRoots:[root],maxRisk:'read'});
  assert.equal(result.ok,true);

  await fs.writeFile(configPath,JSON.stringify({version:1,publishers:[{...publisher,enabled:false}],extensions:[{modulePath:'extension.mjs',package:pkg}]},null,2));
  await loaded.refreshGovernance();
  assert.deepEqual(await runtime.supportedCapabilities(['ext.configured.files.echo']),[]);
  await runtime.close();
});
