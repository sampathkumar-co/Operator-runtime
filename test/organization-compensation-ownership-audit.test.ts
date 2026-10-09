import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamCoordinator } from '../src/core/team-coordinator.ts';
import { OrganizationCoordinator } from '../src/core/organization-coordinator.ts';
import { DurableCompensationJournal } from '../src/core/compensation-journal.ts';

test('foreign child identity in recovery journal never authorizes a different program operation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-org-foreign-intent-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const teams = new TeamCoordinator(dir);
  const org = new OrganizationCoordinator(dir, teams);
  const workItems = [
    { key: 'perform', title: 'Perform', role: 'general' as const },
    { key: 'verify', title: 'Verify', role: 'verifier' as const, dependsOn: ['perform'] }
  ];
  const program = await org.create({
    objective: 'Owner program',
    policy: { allowedScopePrefixes: ['org:owner'] },
    targets: [{ key: 'service', scopeKey: 'org:owner:service', workItems }]
  });
  const unrelated = await teams.submit({
    missionId: crypto.randomUUID(),
    objective: 'Unrelated program mission',
    workItems
  });
  await teams.start(unrelated.id);
  const journal = new DurableCompensationJournal(dir);
  await journal.prepare({
    id: crypto.randomUUID(), ownerKind: 'organization',
    ownerId: program.id, operation: 'cancel-team-mission',
    targetId: unrelated.id, subjectKey: 'service'
  });
  const result = await org.recoverPendingCompensations();
  assert.equal(result.recovered, 0);
  assert.equal(result.pending, 1);
  assert.equal((await teams.inspect(unrelated.id)).state, 'RUNNING');
});
