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
    originalId, quarantineId, claim, signed, workItems,
    ledgerSecret, providerPublicKeyPem: keypair.publicKey.export({ format:'pem', type:'spki' }).toString(),
    deny:()=>{authorized=false;} };
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

test('previously MAC-committed signed decision survives journal-ack crash and attestation expiry', async t => {
  const f = await setup(t);
  const providerClaim = f.signed(f.claim);
  const request = {
    programId: f.program.id, targetKey: 'service', returnedMissionId: f.returnedMissionId,
    operatorId: 'security-admin', providerClaim
  };
  const realComplete = f.journal.complete.bind(f.journal);
  (f.journal as any).complete = async () => { throw new Error('injected crash before quarantine journal retire'); };
  await assert.rejects(f.org.adjudicateQuarantinedIdentity(request), /injected crash/);
  (f.journal as any).complete = realComplete;
  assert.ok((await f.journal.pending('organization')).some(i => i.id === f.quarantineId));
  const preRecovery = await f.adjudicator.list();
  assert.equal(preRecovery.length, 1, 'record must persist before journal acknowledgement');
  const later = new OrganizationQuarantineAdjudicator(f.dir, {
    journal: f.journal, providerPublicKeyPem: f.providerPublicKeyPem,
    ledgerSecret: f.ledgerSecret,
    authorize: async operatorId => {
      if (operatorId !== 'security-admin') throw new Error('operator not authorized');
    },
    clock: () => new Date(Date.parse(f.claim.expiresAt) + 60_000)
  });
  const restartedOrg = new OrganizationCoordinator(f.dir, f.teams, {
    compensations: f.journal, adjudicator: later
  });
  const resumed = await restartedOrg.adjudicateQuarantinedIdentity(request);
  assert.deepEqual(resumed, preRecovery[0]);
  const remaining = await f.journal.pending('organization');
  assert.ok(!remaining.some(i => i.id === f.quarantineId));
  assert.ok(remaining.some(i => i.id === f.originalId),
    'a resumed foreign-ID review must never remove the original orphan child authority');
});

test('expired unsigned/new decisions cannot bypass freshness using an unrelated signed ledger entry', async t => {
  const f = await setup(t);
  const later = new OrganizationQuarantineAdjudicator(f.dir, {
    journal: f.journal, providerPublicKeyPem: f.providerPublicKeyPem,
    ledgerSecret: f.ledgerSecret, authorize: async () => {},
    clock: () => new Date(Date.parse(f.claim.expiresAt) + 60_000)
  });
  const newOrg = new OrganizationCoordinator(f.dir, f.teams, {
    compensations: f.journal, adjudicator: later
  });
  await assert.rejects(newOrg.adjudicateQuarantinedIdentity({
    programId: f.program.id, targetKey: 'service', returnedMissionId: f.returnedMissionId,
    operatorId: 'security-admin', providerClaim: f.signed(f.claim)
  }), (e: any) => e?.code === 'QUARANTINE_EVIDENCE_INVALID');
  assert.ok((await f.journal.pending('organization')).some(i => i.id === f.quarantineId));
});

test('signed claim cannot replace the immutable planned child with a caller-chosen mission ID', async t => {
  const f = await setup(t);
  const foreignExpected = crypto.randomUUID();
  const forged = { ...f.claim, expectedMissionId: foreignExpected };
  await assert.rejects(f.adjudicator.review({
    intentId: f.quarantineId, programId: f.program.id, targetKey: 'service',
    expectedMissionId: foreignExpected, returnedMissionId: f.returnedMissionId,
    operatorId: 'security-admin', providerClaim: f.signed(forged)
  }), (error: any) => error?.code === 'QUARANTINE_EVIDENCE_INVALID');
  const pending = await f.journal.pending('organization');
  assert.ok(pending.some(i => i.id === f.originalId));
  assert.ok(pending.some(i => i.id === f.quarantineId));
  assert.deepEqual(await f.adjudicator.list(), []);
});

test('even valid provider signature and operator authority cannot retire quarantine if original creation prepare is missing', async t => {
  const f = await setup(t);
  await f.journal.complete(f.originalId);
  const input = {
    programId: f.program.id, targetKey: 'service', returnedMissionId: f.returnedMissionId,
    operatorId: 'security-admin', providerClaim: f.signed(f.claim)
  };
  await assert.rejects(f.org.adjudicateQuarantinedIdentity(input),
    (error: any) => error?.code === 'QUARANTINE_ORIGIN_UNVERIFIED');
  const remaining = await f.journal.pending('organization');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, f.quarantineId);
  assert.deepEqual(await f.adjudicator.list(), []);
});

test('external high-water anchor rejects valid MAC ledger truncation and complete deletion', async t => {
  const f = await setup(t);
  let highWater = { count: 0, headMac: '0'.repeat(64) };
  const anchor = {
    read: async () => ({ ...highWater }),
    compareAndAdvance: async (expected: typeof highWater, next: typeof highWater) => {
      assert.deepEqual(highWater, expected, 'independent anchor must provide exact CAS');
      highWater = { ...next };
    }
  };
  const anchored = new OrganizationQuarantineAdjudicator(f.dir, {
    journal: f.journal, ledgerSecret: f.ledgerSecret,
    providerPublicKeyPem: f.providerPublicKeyPem,
    authorize: async id => { assert.equal(id, 'security-admin'); },
    anchor, requireExternalAnchor: true
  });
  await anchored.review({
    intentId: f.quarantineId, programId: f.program.id, targetKey: 'service',
    expectedMissionId: f.claim.expectedMissionId,
    returnedMissionId: f.returnedMissionId, operatorId: 'security-admin',
    providerClaim: f.signed(f.claim)
  });
  assert.equal(highWater.count, 1);
  const file = path.join(f.dir, 'quarantine-adjudications.json');
  const intact = await fs.readFile(file, 'utf8');
  const state = JSON.parse(intact);
  await fs.writeFile(file, JSON.stringify({ ...state, records: [] }));
  await assert.rejects(anchored.list(), (e: any) => e?.code === 'QUARANTINE_LEDGER_ROLLBACK');
  await fs.rm(file);
  await assert.rejects(anchored.list(), (e: any) => e?.code === 'QUARANTINE_LEDGER_ROLLBACK');
  await fs.writeFile(file, intact);
  assert.equal((await anchored.list()).length, 1);
});

test('external anchor handoff crash reconciles one exact MAC-linked commit and resumes original quarantine', async t => {
  const f = await setup(t);
  let highWater = { count: 0, headMac: '0'.repeat(64) };
  let rejectFirstAdvance = true;
  const anchor = {
    read: async () => ({ ...highWater }),
    compareAndAdvance: async (expected: typeof highWater, next: typeof highWater) => {
      assert.deepEqual(expected, highWater);
      if (rejectFirstAdvance) {
        rejectFirstAdvance = false;
        throw new Error('injected independent-anchor crash');
      }
      highWater = { ...next };
    }
  };
  const options = {
    journal: f.journal, ledgerSecret: f.ledgerSecret,
    providerPublicKeyPem: f.providerPublicKeyPem,
    authorize: async (id: string) => { assert.equal(id, 'security-admin'); },
    anchor, requireExternalAnchor: true
  };
  const review = (adjudicator: OrganizationQuarantineAdjudicator) => adjudicator.review({
    intentId: f.quarantineId, programId: f.program.id, targetKey: 'service',
    expectedMissionId: f.claim.expectedMissionId,
    returnedMissionId: f.returnedMissionId, operatorId: 'security-admin',
    providerClaim: f.signed(f.claim)
  });
  await assert.rejects(review(new OrganizationQuarantineAdjudicator(f.dir, options)),
    (e: any) => e?.code === 'QUARANTINE_ANCHOR_UNAVAILABLE');
  assert.equal(highWater.count, 0);
  assert.ok((await f.journal.pending('organization')).some(x => x.id === f.quarantineId),
    'failed external anchor cannot retire quarantine');
  const recovered = new OrganizationQuarantineAdjudicator(f.dir, options);
  const committed = await recovered.list();
  assert.equal(committed.length, 1);
  assert.equal(highWater.count, 1, 'single fully MAC-linked local record advances anchor after crash');
  await review(recovered);
  assert.ok(!(await f.journal.pending('organization')).some(x => x.id === f.quarantineId));
  assert.ok((await f.journal.pending('organization')).some(x => x.id === f.originalId),
    'original child cancellation intent must never be erased by foreign-ID adjudication');
});

test('production strict mode requires independently configured quarantine ledger anchor', async t => {
  const f = await setup(t);
  assert.throws(() => new OrganizationQuarantineAdjudicator(f.dir, {
    journal: f.journal, ledgerSecret: f.ledgerSecret,
    providerPublicKeyPem: f.providerPublicKeyPem,
    authorize: async () => {}, requireExternalAnchor: true
  }), (e: any) => e?.code === 'QUARANTINE_ANCHOR_REQUIRED');
});
