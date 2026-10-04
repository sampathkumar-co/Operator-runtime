import assert from 'node:assert/strict';
import test from 'node:test';
import { renderControlCenter } from '../apps/local-agent/src/control-center.ts';
import type { ActionJournalEntry } from '../src/core/action-transition-journal.ts';
import { projectTaskRuntime } from '../src/core/runtime-projection.ts';
import { createTask } from '../src/core/task.ts';

test('runtime projection derives bounded operator state from authoritative task, journal, and approval truth', () => {
  const task = createTask({
    userObjective: 'Safely update the selected record',
    interpretedObjective: 'Update and verify one record',
    authorizedScope: ['database:records'],
    prohibitedScope: [],
    successConditions: ['record matches requested value'],
    intent: { conversationId: 'conversation-1', intentVersion: 4, digest: 'a'.repeat(64) },
    execution: {
      schemaVersion: 1,
      plannerId: 'planner',
      goalKind: 'autonomous-workflow',
      plannerState: {},
      maxSteps: 4,
      maxAttemptsPerStep: 2,
      timeoutMs: 30_000,
      stepCount: 1,
      records: [{
        stepKey: 'update',
        actionId: 'action-1',
        capability: 'database.update',
        risk: 'write',
        inputHash: 'b'.repeat(64),
        attempt: 1,
        state: 'BLOCKED',
        startedAt: '2026-10-04T00:00:00.000Z',
        errorCode: 'ACTION_RECONCILIATION_REQUIRED',
        executionPhase: 'dispatched',
        sideEffectState: 'uncertain',
        observation: {
          schemaVersion: 2,
          channel: 'semantic',
          domain: 'database',
          provider: 'postgres',
          capability: 'database.read',
          entityId: 'record:1',
          observedAt: '2026-10-04T00:00:01.000Z',
          stateVersion: 'revision-9',
          importantState: { id: 1 },
          ambiguous: false,
          confidence: 0.99,
          evidenceRefs: ['evidence-1']
        },
        evidence: []
      }],
      plannerEvents: []
    }
  });
  task.state = 'BLOCKED';
  task.failures.push({
    at: '2026-10-04T00:00:02.000Z',
    code: 'ACTION_RECONCILIATION_REQUIRED',
    message: 'Provider state must be reconciled before continuing.'
  });
  task.evidence.push({
    kind: 'action_verification',
    status: 'fail',
    message: 'Verification remains inconclusive.',
    data: { digest: 'c'.repeat(64) },
    timestamp: '2026-10-04T00:00:02.000Z'
  });
  const journal: ActionJournalEntry = {
    version: 1,
    actionId: 'action-1',
    actionDigest: 'd'.repeat(64),
    ownerKind: 'task',
    ownerId: task.id,
    capability: 'database.update',
    risk: 'write',
    intent: task.intent,
    resourceKeys: ['database:records:1'],
    generation: 1,
    state: 'UNCERTAIN',
    transitions: [
      { seq: 1, state: 'PREPARED', at: '2026-10-04T00:00:00.000Z' },
      { seq: 2, state: 'DISPATCHED', at: '2026-10-04T00:00:01.000Z', provider: 'postgres' },
      { seq: 3, state: 'UNCERTAIN', at: '2026-10-04T00:00:02.000Z', provider: 'postgres' }
    ],
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:02.000Z'
  };

  const projection = projectTaskRuntime(task, {
    journal: [journal],
    approvals: [{
      actionId: 'action-1',
      approvalRequestId: 'approval-1',
      capability: 'database.update',
      risk: 'write',
      status: 'pending',
      pendingExpiresAt: '2026-10-04T00:10:00.000Z'
    }]
  });

  assert.deepEqual(projection.intent, {
    conversationId: task.intent?.conversationId,
    version: task.intent?.intentVersion,
    digest: task.intent?.digest
  });
  assert.equal(projection.pendingApproval?.approvalRequestId, 'approval-1');
  assert.equal(projection.currentAction?.executionPhase, 'dispatched');
  assert.equal(projection.provider, 'postgres');
  assert.deepEqual(projection.resources, ['database:records:1']);
  assert.equal(projection.lastObservation?.stateVersion, 'revision-9');
  assert.deepEqual(projection.verification, { state: 'failed', digest: 'c'.repeat(64) });
  assert.equal(projection.reconciliationRequired, true);
  assert.equal(projection.blocker?.code, 'ACTION_RECONCILIATION_REQUIRED');
});

test('Control Center fetches and renders the authoritative runtime projection', () => {
  const html = renderControlCenter('nonce_test');
  assert.equal(html.includes('/v1/control-center/runtime?limit=200'), true);
  assert.equal(html.includes('Authoritative runtime projection'), true);
  assert.equal(html.includes('JSON.stringify(projection,null,2)'), true);
});
