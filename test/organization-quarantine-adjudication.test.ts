import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';
import { OrganizationQuarantineAdjudicator, type ProviderQuarantineClaim } from '../src/core/organization-quarantine-adjudication.ts';

function expectedId(programId: string, targetKey: string): string {
  const bytes = crypto.createHash('sha256').update(`organization-mission\0${programId}\0${targetKey}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function intentId(programId: string, operation: string, targetId: string): string {
  return 'organization:' + crypto.createHash('sha256')
    .update(`${programId}\0${operation}\0${targetId}`,'utf8').digest('hex');
}

async function setup(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-quarantine-adjudication-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const teams = new TeamCoordinator(dir);
  const journal = new DurableCompensationJournal(dir);
  const keypair = crypto.generateKeyPairSync('ed25519');
  const ledgerSecret = crypto.randomBytes(32);
  let authorized = true;
  const adjudicator = new OrganizationQuarantineAdjudicator(dir, {
    journal, providerPublicKeyPem: keypair.publicKey.export({ format:'pem', type:'spki' }).toString(),
    ledgerSecret,
    authorize: async (operatorId) => {
      if (!authorized || operatorId !== 'security-admin') throw new Error('operator not authorized');
    }
  });
  const org = new OrganizationCoordinator(dir, teams, { compensations: journal, adjudicator });
  const workItems = [
    { key:'run', title:'Run', role:'general' as const },
    { key:'verify', title:'Verify', role:'verifier' as const, dependsOn:['run'] }
  ];
  const program = await org.create({ objective:'Auditable owner program',
    policy: { allowedScopePrefixes:['org:signed'] },
    targets: [{ key:'service', scopeKey:'org:signed:service', workItems }] });
  const returnedMissionId = crypto.randomUUID();
  const plannedMissionId = expectedId(program.id,'service');
  const quarantineId = intentId(program.id,'reconcile-untrusted-team-identity',returnedMissionId);
  const originalId = intentId(program.id,'cancel-team-mission',plannedMissionId);
  await journal.prepare({ id: originalId, ownerKind:'organization', ownerId:program.id,
    subjectKey:'service', targetId:plannedMissionId, operation:'cancel-team-mission' });
  await journal.prepare({ id: quarantineId, ownerKind:'organization', ownerId:program.id,
    subjectKey:'service', targetId:returnedMissionId, operation:'reconcile-untrusted-team-identity' });
  const now = Date.now();
  const claim: ProviderQuarantineClaim = {
    schemaVersion:1, intentId:quarantineId, programId:program.id, targetKey:'service',
    expectedMissionId:plannedMissionId, returnedMissionId, classification:'verified-unrelated',
    evidenceDigest:crypto.createHash('sha256').update('independent-provider-origin-ledger').digest('hex'),
    providerDeviceId:crypto.randomUUID(), providerProcessId:'provider:worker-123',
    providerSessionId:crypto.randomUUID(), authorityGeneration:4,
    issuedAt:new Date(now-1000).toISOString(), expiresAt:new Date(now+60000).toISOString()
  };
  const signed = (value: ProviderQuarantineClaim) => ({
    claim:value,
    signature:crypto.sign(null,Buffer.from(JSON.stringify(value),'utf8'),keypair.privateKey).toString('base64url')
  });
  return { dir, teams, org, journal, adjudicator, program, returnedMissionId,
    originalId, quarantineId, claim, signed, workItems, deny:()=>{authorized=false;} };
}

test('signed independent provider proof and operator approval retire only foreign-ID quarantine', async t => {
  const f = await setup(t);
  const foreign = await f.teams.submit({missionId:f.returnedMissionId,
    objective:'UNRELATED other program mission',workItems:f.workItems});
  await f.teams.start(foreign.id);
  const record = await f.org.adjudicateQuarantinedIdentity({
    programId:f.program.id, targetKey:'service', returnedMissionId:foreign.id,
    operatorId:'security-admin', providerClaim:f.signed(f.claim)
  });
  assert.equal(record.classification,'verified-unrelated');
  assert.equal((await f.teams.inspect(foreign.id)).state,'RUNNING');
  const remaining=await f.journal.pending('organization');
  assert.ok(remaining.some(i=>i.id===f.originalId),'expected child compensation stays pending');
  assert.ok(!remaining.some(i=>i.id===f.quarantineId),'only foreign-ID quarantine was retired');
  const repeat=await f.org.adjudicateQuarantinedIdentity({
    programId:f.program.id, targetKey:'service', returnedMissionId:foreign.id,
    operatorId:'security-admin', providerClaim:f.signed(f.claim)
  });
  assert.deepEqual(repeat,record,'same signed decision is idempotent after restart');
});

test('wrong signature, mismatched identities, unresolved state and denied operator fail closed',async t=>{
  const f=await setup(t);
  const request={programId:f.program.id,targetKey:'service',returnedMissionId:f.returnedMissionId,
    operatorId:'security-admin',providerClaim:f.signed(f.claim)};
  await assert.rejects(f.org.adjudicateQuarantinedIdentity({...request,providerClaim:{
    ...request.providerClaim,signature:crypto.sign(null,Buffer.from('unrelated'),crypto.generateKeyPairSync('ed25519').privateKey).toString('base64url')
  }}),(e:any)=>e?.code==='QUARANTINE_EVIDENCE_INVALID');
  await assert.rejects(f.org.adjudicateQuarantinedIdentity({...request,providerClaim:f.signed({
    ...f.claim,targetKey:'wrong-target'
  })}),(e:any)=>e?.code==='QUARANTINE_EVIDENCE_INVALID');
  await assert.rejects(f.org.adjudicateQuarantinedIdentity({...request,providerClaim:f.signed({
    ...f.claim,classification:'unresolved'
  })}),(e:any)=>e?.code==='QUARANTINE_UNRESOLVED');
  f.deny();
  await assert.rejects(f.org.adjudicateQuarantinedIdentity(request),/operator not authorized/);
  assert.equal((await f.journal.pending('organization')).length,2);
});

test('verified-owned classification cannot silently cancel claimed child or remove cleanup authority',async t=>{
  const f=await setup(t);
  const owned=await f.org.adjudicateQuarantinedIdentity({
    programId:f.program.id,targetKey:'service',returnedMissionId:f.returnedMissionId,
    operatorId:'security-admin',providerClaim:f.signed({...f.claim,classification:'verified-owned'})
  });
  assert.equal(owned.classification,'verified-owned');
  const pending=await f.journal.pending('organization');
  assert.equal(pending.length,2,'operator classification alone is never a terminal effect receipt');
});

test('MAC chain rejects in-place ledger edits after restart',async t=>{
  const f=await setup(t);
  await f.org.adjudicateQuarantinedIdentity({
    programId:f.program.id,targetKey:'service',returnedMissionId:f.returnedMissionId,
    operatorId:'security-admin',providerClaim:f.signed(f.claim)
  });
  const file=path.join(f.dir,'quarantine-adjudications.json');
  const state=JSON.parse(await fs.readFile(file,'utf8'));
  state.records[0].operatorId='attacker';
  await fs.writeFile(file,JSON.stringify(state));
  await assert.rejects(f.adjudicator.list(),(e:any)=>e?.code==='QUARANTINE_LEDGER_CORRUPT');
});
