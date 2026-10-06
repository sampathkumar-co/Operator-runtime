import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  applyMultiFileEditPlan,
  createMultiFileEditPlan,
  validateMultiFileEditPlan
} from '../src/core/multi-file-edit-plan.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('multi-file edit plan applies exact stale-bound edits and produces deterministic preview', () => {
  const a = 'export const value = 1;\n';
  const b = 'export function run() { return value; }\n';
  const plan = createMultiFileEditPlan({
    files: [
      {
        path: 'src/b.ts',
        expectedSha256: digest(b),
        edits: [{ start: b.indexOf('value'), end: b.indexOf('value') + 5, replacement: 'nextValue' }]
      },
      {
        path: 'src/a.ts',
        expectedSha256: digest(a),
        edits: [{ start: a.indexOf('value'), end: a.indexOf('value') + 5, replacement: 'nextValue' }]
      }
    ],
    verification: {
      trustedCommandIds: ['typecheck', 'unit-tests'],
      requiredTestPaths: ['test/a.test.ts']
    }
  });

  assert.deepEqual(plan.files.map((file) => file.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plan.verification.trustedCommandIds, ['typecheck', 'unit-tests']);

  const applied = applyMultiFileEditPlan(plan, {
    'src/a.ts': a,
    'src/b.ts': b
  });

  assert.match(applied.contentByPath['src/a.ts']!, /nextValue/);
  assert.match(applied.contentByPath['src/b.ts']!, /nextValue/);
  assert.equal(applied.preview.files.length, 2);
  assert.equal(applied.preview.files.every((file) => file.beforeSha256 !== file.afterSha256), true);
  assert.equal(validateMultiFileEditPlan(plan).id, plan.id);
});

test('multi-file edit plan fails closed when any target is stale', () => {
  const original = 'const answer = 41;\n';
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/answer.ts',
      expectedSha256: digest(original),
      edits: [{ start: original.indexOf('41'), end: original.indexOf('41') + 2, replacement: '42' }]
    }]
  });

  assert.throws(() => applyMultiFileEditPlan(plan, {
    'src/answer.ts': 'const answer = 99;\n'
  }), /changed since planning/);
});

test('overlapping edit ranges are rejected before execution', () => {
  assert.throws(() => createMultiFileEditPlan({
    files: [{
      path: 'src/a.ts',
      expectedSha256: 'a'.repeat(64),
      edits: [
        { start: 0, end: 4, replacement: 'x' },
        { start: 3, end: 5, replacement: 'y' }
      ]
    }]
  }), /overlap/);
});

test('edit ranges cannot split Unicode surrogate pairs', () => {
  const current = 'const face = "😀";\n';
  const emojiOffset = current.indexOf('😀');
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/emoji.ts',
      expectedSha256: digest(current),
      edits: [{ start: emojiOffset + 1, end: emojiOffset + 2, replacement: 'X' }]
    }]
  });

  assert.throws(() => applyMultiFileEditPlan(plan, {
    'src/emoji.ts': current
  }), /surrogate pair/);
});

test('edit plans reject traversal, absolute paths, duplicate targets, and tampering', () => {
  assert.throws(() => createMultiFileEditPlan({
    files: [{
      path: '../outside.ts',
      expectedSha256: 'a'.repeat(64),
      edits: [{ start: 0, end: 0, replacement: 'x' }]
    }]
  }), /inside the workspace/);

  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/a.ts',
      expectedSha256: digest('a'),
      edits: [{ start: 0, end: 1, replacement: 'b' }]
    }]
  });
  const tampered = structuredClone(plan);
  tampered.files[0]!.edits[0]!.replacement = 'c';
  assert.throws(() => validateMultiFileEditPlan(tampered), /id does not match/);

  assert.throws(() => createMultiFileEditPlan({
    files: [
      {
        path: 'src/a.ts',
        expectedSha256: 'a'.repeat(64),
        edits: [{ start: 0, end: 0, replacement: 'x' }]
      },
      {
        path: 'src/a.ts',
        expectedSha256: 'b'.repeat(64),
        edits: [{ start: 0, end: 0, replacement: 'y' }]
      }
    ]
  }), /Duplicate edit target/);
});

test('preview identifies bounded changed line range', () => {
  const current = ['line 1', 'line 2', 'line 3', 'line 4'].join('\n');
  const start = current.indexOf('line 2');
  const end = current.indexOf('line 4') - 1;
  const plan = createMultiFileEditPlan({
    files: [{
      path: 'src/a.txt.ts',
      expectedSha256: digest(current),
      edits: [{ start, end, replacement: 'changed 2\nchanged 3' }]
    }]
  });

  const applied = applyMultiFileEditPlan(plan, { 'src/a.txt.ts': current });
  const preview = applied.preview.files[0]!;
  assert.equal(preview.firstChangedLine, 2);
  assert.ok((preview.lastChangedLineBefore ?? 0) >= 2);
  assert.ok((preview.lastChangedLineAfter ?? 0) >= 2);
});
