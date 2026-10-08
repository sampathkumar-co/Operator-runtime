import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadIndependentEvidenceCli } from '../scripts/independent-evidence-cli.ts';

test('unsigned evaluation remains scoring-only; flags must be complete', async () => {
  assert.equal(await loadIndependentEvidenceCli([]),undefined);
  await assert.rejects(()=>loadIndependentEvidenceCli(['--evidence','x']),/Expected:/);
});

test('external campaign evidence cannot inject the trusted signing key', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'campaign-evidence-cli-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {publicKey}=crypto.generateKeyPairSync('ed25519');
  const pem=publicKey.export({type:'spki',format:'pem'}).toString();
  const bundlePath=path.join(dir,'bundle.json');
  const keyPath=path.join(dir,'operator-pinned.pem');
  const attestation={schemaVersion:1,verifierId:'verifier-0',campaignDigest:'a'.repeat(64),artifactDigests:[],signatureBase64:''};
  await fs.writeFile(keyPath,pem);
  await fs.writeFile(bundlePath,JSON.stringify({attestation,artifacts:[],trustedVerifierPublicKeys:{'verifier-0':'attacker-controlled'}}));
  const args=['--evidence',bundlePath,'--verifier-id','verifier-0','--trusted-public-key',keyPath];
  await assert.rejects(()=>loadIndependentEvidenceCli(args),/must not supply or override trusted/);
  await fs.writeFile(bundlePath,JSON.stringify({attestation,artifacts:[]}));
  const loaded=await loadIndependentEvidenceCli(args);
  assert.equal(loaded?.trustedVerifierPublicKeys['verifier-0'],pem);
  await assert.rejects(()=>loadIndependentEvidenceCli(['--evidence',keyPath,'--verifier-id','verifier-0','--trusted-public-key',keyPath]),/cannot use the same file/);
});
