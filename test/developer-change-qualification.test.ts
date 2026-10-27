import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createDeveloperChangeQualificationPlan,
  validateDeveloperChangeQualificationPlan
} from '../src/core/developer-change-qualification.ts';
import { createMultiFileEditPlan } from '../src/core/multi-file-edit-plan.ts';
import type { ActionResult } from '../src/core/types.ts';

function editPlan(options: {
  trustedCommandIds?: string[];
  requiredTestPaths?: string[];
} = {}) {
  return createMultiFileEditPlan({
    files: [{
      path: 'src/value.ts',
      expectedSha256: 'a'.repeat(64),
      edits: [{ start: 0, end: 0, replacement: '// changed\n' }]
    }],
    verification: {
      trustedCommandIds: options.trustedCommandIds ?? [],
      requiredTestPaths: options.requiredTestPaths ?? ['test/value.test.ts']
    }
  });
}

function inspection(commands: Array<Record<string, unknown>>): ActionResult {
  return {
    ok: true,
    capability: 'project.command.inspect',
    provider: 'project.command.trusted',
    output: {
      projectRoot: path.resolve('fixture-project'),
      registryConfigured: true,
      commands
    },
    evidence: [{
      kind: 'command_registry',
      status: 'pass',
      message: 'trusted local registry',
      timestamp: '2026-10-06T00:00:00.000Z'
    }],
    durationMs: 1
  };
}

const standardCommands = [
  { id: 'build', kind: 'build', risk: 'read' },
  { id: 'unit', kind: 'test', risk: 'read' },
  { id: 'lint', kind: 'lint', risk: 'read' },
  { id: 'format', kind: 'format', risk: 'write' },
  { id: 'serve', kind: 'dev', risk: 'write' },
  { id: 'db', kind: 'database', risk: 'write' },
  { id: 'remote-check', kind: 'test', risk: 'external' }
];

test('qualification plan orders local trusted format lint test build commands deterministically', () => {
  const plan = createDeveloperChangeQualificationPlan({
    editPlan: editPlan(),
    trustedCommandInspection: inspection([...standardCommands].reverse())
  });

  assert.deepEqual(
    plan.steps.map((step) => [step.commandId, step.kind, step.risk]),
    [
      ['format', 'format', 'write'],
      ['lint', 'lint', 'read'],
      ['unit', 'test', 'read'],
      ['build', 'build', 'read']
    ]
  );
  assert.deepEqual(plan.changedPaths, ['src/value.ts']);
  assert.deepEqual(plan.requiredTestPaths, ['test/value.test.ts']);
  assert.equal(plan.reindexAfterFormatting, true);
  assert.equal(plan.steps.some((step) => step.commandId === 'remote-check'), false);
  assert.equal(plan.steps.some((step) => step.commandId === 'serve'), false);
  assert.equal(plan.steps.some((step) => step.commandId === 'db'), false);

  const validated = validateDeveloperChangeQualificationPlan(plan);
  assert.deepEqual(validated, plan);
});

test('explicit trusted command ids constrain qualification to the immutable edit-plan request', () => {
  const plan = createDeveloperChangeQualificationPlan({
    editPlan: editPlan({
      trustedCommandIds: ['lint', 'unit'],
      requiredTestPaths: ['test/value.test.ts']
    }),
    trustedCommandInspection: inspection(standardCommands)
  });
  assert.deepEqual(plan.steps.map((step) => step.commandId), ['lint', 'unit']);
  assert.equal(plan.reindexAfterFormatting, false);
});

test('missing explicitly requested trusted command fails closed', () => {
  assert.throws(
    () => createDeveloperChangeQualificationPlan({
      editPlan: editPlan({
        trustedCommandIds: ['lint', 'missing-command']
      }),
      trustedCommandInspection: inspection(standardCommands)
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_COMMAND_MISSING');
      return true;
    }
  );
});

test('affected test paths require at least one selected local trusted test command', () => {
  assert.throws(
    () => createDeveloperChangeQualificationPlan({
      editPlan: editPlan({
        trustedCommandIds: ['lint', 'build'],
        requiredTestPaths: ['test/value.test.ts']
      }),
      trustedCommandInspection: inspection(standardCommands)
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_TEST_COMMAND_REQUIRED');
      return true;
    }
  );
});

test('formatter-only registry cannot certify a code change', () => {
  assert.throws(
    () => createDeveloperChangeQualificationPlan({
      editPlan: editPlan({ requiredTestPaths: [] }),
      trustedCommandInspection: inspection([
        { id: 'format', kind: 'format', risk: 'write' }
      ])
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_VERIFIER_REQUIRED');
      return true;
    }
  );
});

test('external trusted commands are not silently promoted into local workstation qualification', () => {
  assert.throws(
    () => createDeveloperChangeQualificationPlan({
      editPlan: editPlan(),
      trustedCommandInspection: inspection([
        { id: 'remote-test', kind: 'test', risk: 'external' }
      ])
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_COMMANDS_UNAVAILABLE');
      return true;
    }
  );
});

test('qualification rejects results not proven by trusted project-command inspection', () => {
  const untrusted = inspection(standardCommands);
  untrusted.provider = 'other-provider';
  assert.throws(
    () => createDeveloperChangeQualificationPlan({
      editPlan: editPlan(),
      trustedCommandInspection: untrusted
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_REGISTRY_UNTRUSTED');
      return true;
    }
  );
});

test('qualification plan content address detects tampering', () => {
  const plan = createDeveloperChangeQualificationPlan({
    editPlan: editPlan(),
    trustedCommandInspection: inspection(standardCommands)
  });
  const tampered = structuredClone(plan);
  tampered.steps[0]!.reason = 'forged reason';
  assert.throws(
    () => validateDeveloperChangeQualificationPlan(tampered),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
      return true;
    }
  );
});

test('read-only formatter does not require post-format reindex flag', () => {
  const plan = createDeveloperChangeQualificationPlan({
    editPlan: editPlan({ requiredTestPaths: [] }),
    trustedCommandInspection: inspection([
      { id: 'format-check', kind: 'format', risk: 'read' },
      { id: 'lint', kind: 'lint', risk: 'read' }
    ])
  });
  assert.equal(plan.reindexAfterFormatting, false);
  assert.deepEqual(plan.steps.map((step) => step.commandId), ['format-check', 'lint']);
});


test('C06 registry validation never executes command id/kind accessor or coercion code', () => {
  let invoked = 0;
  const getter = Object.defineProperty({ id: 'unit', risk: 'read' }, 'kind', {
    enumerable: true, get() { invoked++; throw Error('unexpected accessor call'); }
  });
  assert.throws(() => createDeveloperChangeQualificationPlan({
    editPlan: editPlan(),
    trustedCommandInspection: inspection([getter as Record<string, unknown>])
  }), (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_REGISTRY_INVALID');
  const coercible = { id: { toString() { invoked++; return 'unit'; } }, kind: 'test', risk: 'read' };
  assert.throws(() => createDeveloperChangeQualificationPlan({
    editPlan: editPlan(),
    trustedCommandInspection: inspection([coercible])
  }), (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_REGISTRY_INVALID');
  assert.equal(invoked, 0);
});

test('C06 qualification rejects untrusted plan getters and coercible path/step identities', () => {
  const valid = createDeveloperChangeQualificationPlan({
    editPlan: editPlan(), trustedCommandInspection: inspection(standardCommands)
  });
  let invoked = 0;
  const forged = structuredClone(valid);
  Object.defineProperty(forged.steps[0], 'commandId', {
    enumerable: true, get() { invoked++; throw Error('must never execute'); }
  });
  assert.throws(() => validateDeveloperChangeQualificationPlan(forged),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
  const coercible = structuredClone(valid);
  coercible.changedPaths[0] = { toString() { invoked++; return 'src/value.ts'; } } as any;
  assert.throws(() => validateDeveloperChangeQualificationPlan(coercible),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
  const scope = structuredClone(valid);
  scope.projectRoot = [scope.projectRoot] as any;
  assert.throws(() => validateDeveloperChangeQualificationPlan(scope),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
  assert.equal(invoked, 0);
});

test('C06 hidden scope metadata and sparse qualification arrays cannot validate', () => {
  const valid = createDeveloperChangeQualificationPlan({
    editPlan: editPlan(), trustedCommandInspection: inspection(standardCommands)
  });
  const hidden = structuredClone(valid);
  Object.defineProperty(hidden, 'executeAnything', { value: true, enumerable: false });
  assert.throws(() => validateDeveloperChangeQualificationPlan(hidden),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
  const symbolic = structuredClone(valid);
  Object.assign(symbolic, { [Symbol('permission')]: true });
  assert.throws(() => validateDeveloperChangeQualificationPlan(symbolic),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
  const sparse = structuredClone(valid);
  delete sparse.steps[0];
  assert.throws(() => validateDeveloperChangeQualificationPlan(sparse),
    (error: any) => error?.code === 'DEVELOPER_QUALIFICATION_PLAN_INVALID');
});
