import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createDeveloperSession,
  DeveloperSessionStore,
  updateDeveloperSession
} from '../src/core/developer-session.ts';
import { DeveloperVerificationCoordinator } from '../src/core/developer-verification.ts';
import { ArtifactStore } from '../src/core/artifact-store.ts';
import type { ActionRequest, ActionResult } from '../src/core/types.ts';

async function fixture(t: TestContext) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-dev-verify-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const store = new DeveloperSessionStore(stateDir);
  const created = createDeveloperSession({
    objective: 'Verify a developer change',
    acceptanceCriteria: [
      'Unit tests pass.',
      'Lint remains clean.'
    ],
    workspaceRootNodeId: 'workspace-root',
    now: '2026-10-06T00:00:00.000Z'
  });
  const active = updateDeveloperSession(
    created,
    { status: 'ACTIVE' },
    '2026-10-06T00:00:01.000Z'
  );
  await store.put(active);
  return {
    stateDir,
    store,
    session: active,
    coordinator: new DeveloperVerificationCoordinator(stateDir)
  };
}

function commandAction(commandId: string, id = 'action-' + commandId): ActionRequest {
  return {
    id,
    capability: 'project.command.run',
    risk: 'read',
    input: { commandId, expectedRisk: 'read', path: '/workspace' },
    provenance: { kind: 'trusted_policy', source: 'test' }
  };
}

function commandResult(commandId: string, ok: boolean, secret = ''): ActionResult {
  return {
    ok,
    capability: 'project.command.run',
    provider: 'project.command.trusted',
    output: {
      command: { id: commandId },
      execution: {
        stdout: secret ? 'TOP_SECRET_OUTPUT=' + secret : 'ok',
        stderr: ''
      }
    },
    evidence: [
      {
        kind: 'command_registry',
        status: 'pass',
        message: 'Executed trusted command ' + commandId,
        data: {
          forbiddenRawOutput: secret ? 'TOP_SECRET_OUTPUT=' + secret : ''
        },
        timestamp: '2026-10-06T00:00:02.000Z'
      },
      {
        kind: 'process_exit',
        status: ok ? 'pass' : 'fail',
        message: ok ? 'exit 0' : 'exit 1',
        timestamp: '2026-10-06T00:00:02.000Z'
      }
    ],
    ...(ok ? {} : {
      error: {
        code: 'NONZERO_EXIT',
        message: 'Process exited with code 1.',
        retryable: false
      }
    }),
    durationMs: 25
  };
}

const context = (sessionId: string) => ({
  schemaVersion: 1 as const,
  sessionId
});

test('verification start requires complete acceptance-criterion coverage', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    () => fx.coordinator.start({
      developerSessionId: fx.session.id,
      requirements: [
        { commandId: 'test', criterionIndexes: [0] }
      ],
      now: '2026-10-06T00:00:02.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_COVERAGE_INCOMPLETE');
      return true;
    }
  );
});

test('trusted passing receipts complete session and produce Evidence Pack', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0] },
      { commandId: 'lint', criterionIndexes: [1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });
  assert.equal(started.session.status, 'VERIFYING');

  const testReceipt = await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('test'),
    result: commandResult('test', true, 'SHOULD_NOT_PERSIST'),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:03.000Z'
  });
  const lintReceipt = await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('lint'),
    result: commandResult('lint', true),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:04.000Z'
  });

  const artifacts = new ArtifactStore(fx.stateDir);
  const rawReceipt = await artifacts.read(testReceipt.artifactId);
  const receiptText = rawReceipt.bytes.toString('utf8');
  assert.equal(receiptText.includes('SHOULD_NOT_PERSIST'), false);
  assert.equal(receiptText.includes('stdout'), false);
  assert.equal(receiptText.includes('stderr'), false);

  const finalized = await fx.coordinator.finalize(
    started.run.id,
    '2026-10-06T00:00:05.000Z'
  );
  assert.equal(finalized.verified, true);
  assert.equal(finalized.session.status, 'COMPLETED');
  assert.deepEqual(finalized.missingCommandIds, []);
  assert.deepEqual(finalized.failedCommandIds, []);
  assert.ok(finalized.evidencePack);
  assert.ok(finalized.evidencePackArtifactId);
  assert.equal(finalized.evidencePack?.claims.length, 2);
  assert.ok(
    finalized.evidencePack?.claims.every((claim) => claim.level === 'EMPIRICALLY_VERIFIED')
  );
  assert.ok(finalized.session.artifactIds.includes(testReceipt.artifactId));
  assert.ok(finalized.session.artifactIds.includes(lintReceipt.artifactId));
  assert.ok(finalized.session.artifactIds.includes(finalized.evidencePackArtifactId!));
});

test('untrusted or wrong-provider command results cannot become verification receipts', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  const untrusted: ActionResult = {
    ...commandResult('test', true),
    provider: 'process.argv'
  };
  await assert.rejects(
    () => fx.coordinator.recordAuthorizedCommandResult({
      runId: started.run.id,
      action: commandAction('test'),
      result: untrusted,
      executionContext: context(fx.session.id),
      now: '2026-10-06T00:00:03.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_RESULT_UNTRUSTED');
      return true;
    }
  );
});

test('failed latest receipt blocks completion until a newer trusted pass exists', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0] },
      { commandId: 'lint', criterionIndexes: [1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('test'),
    result: commandResult('test', false),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:03.000Z'
  });
  await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('lint'),
    result: commandResult('lint', true),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:04.000Z'
  });

  const blocked = await fx.coordinator.finalize(
    started.run.id,
    '2026-10-06T00:00:05.000Z'
  );
  assert.equal(blocked.verified, false);
  assert.equal(blocked.session.status, 'BLOCKED');
  assert.deepEqual(blocked.failedCommandIds, ['test']);

  await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('test', 'action-test-retry'),
    result: commandResult('test', true),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:06.000Z'
  });

  const completed = await fx.coordinator.finalize(
    started.run.id,
    '2026-10-06T00:00:07.000Z'
  );
  assert.equal(completed.verified, true);
  assert.equal(completed.session.status, 'COMPLETED');
});

test('tampering the mutable run index cannot turn a failed immutable receipt into success', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('test'),
    result: commandResult('test', false),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:03.000Z'
  });

  const runPath = path.join(
    fx.stateDir,
    'developer-verification-runs',
    started.run.id + '.json'
  );
  const raw = JSON.parse(await fs.readFile(runPath, 'utf8')) as {
    receipts: Array<{ ok: boolean }>
  };
  raw.receipts[0]!.ok = true;
  await fs.writeFile(runPath, JSON.stringify(raw, null, 2));

  await assert.rejects(
    () => fx.coordinator.finalize(
      started.run.id,
      '2026-10-06T00:00:04.000Z'
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_RECEIPT_INVALID');
      return true;
    }
  );
});

test('finalization is idempotent after Evidence Pack publication', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });
  await fx.coordinator.recordAuthorizedCommandResult({
    runId: started.run.id,
    action: commandAction('test'),
    result: commandResult('test', true),
    executionContext: context(fx.session.id),
    now: '2026-10-06T00:00:03.000Z'
  });

  const first = await fx.coordinator.finalize(
    started.run.id,
    '2026-10-06T00:00:04.000Z'
  );
  const second = await fx.coordinator.finalize(
    started.run.id,
    '2026-10-06T00:00:05.000Z'
  );
  assert.equal(first.evidencePackArtifactId, second.evidencePackArtifactId);
  assert.equal(second.verified, true);
  assert.equal(second.session.status, 'COMPLETED');
});


test('verification receipt context must bind the same Developer Session', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  await assert.rejects(
    () => fx.coordinator.recordAuthorizedCommandResult({
      runId: started.run.id,
      action: commandAction('test'),
      result: commandResult('test', true),
      executionContext: { schemaVersion: 1, sessionId: 'different-session' },
      now: '2026-10-06T00:00:03.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_CONTEXT_MISMATCH');
      return true;
    }
  );
});

test('trusted provider result cannot be credited to a different command id', async (t) => {
  const fx = await fixture(t);
  const started = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  const mismatched = commandResult('lint', true);
  await assert.rejects(
    () => fx.coordinator.recordAuthorizedCommandResult({
      runId: started.run.id,
      action: commandAction('test'),
      result: mismatched,
      executionContext: context(fx.session.id),
      now: '2026-10-06T00:00:03.000Z'
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_RESULT_MISMATCH');
      return true;
    }
  );
});

test('run file identity must match the requested run id path', async (t) => {
  const fx = await fixture(t);
  const first = await fx.coordinator.start({
    developerSessionId: fx.session.id,
    requirements: [
      { commandId: 'test', criterionIndexes: [0, 1] }
    ],
    now: '2026-10-06T00:00:02.000Z'
  });

  const secondSession = updateDeveloperSession(
    createDeveloperSession({
      objective: 'Second verification session',
      acceptanceCriteria: ['Another criterion.'],
      workspaceRootNodeId: 'workspace-root-2',
      now: '2026-10-06T00:01:00.000Z'
    }),
    { status: 'ACTIVE' },
    '2026-10-06T00:01:01.000Z'
  );
  await fx.store.put(secondSession);
  const second = await fx.coordinator.start({
    developerSessionId: secondSession.id,
    requirements: [
      { commandId: 'lint', criterionIndexes: [0] }
    ],
    now: '2026-10-06T00:01:02.000Z'
  });

  const root = path.join(fx.stateDir, 'developer-verification-runs');
  const secondBytes = await fs.readFile(path.join(root, second.run.id + '.json'));
  await fs.writeFile(path.join(root, first.run.id + '.json'), secondBytes);

  await assert.rejects(
    () => fx.coordinator.get(first.run.id),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_VERIFICATION_RUN_CORRUPT');
      return true;
    }
  );
});
