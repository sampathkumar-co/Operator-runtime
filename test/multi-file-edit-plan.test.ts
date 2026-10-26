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

test('C06 replacement bytes cannot come from arrays, numbers or attacker-owned coercion hooks', () => {
  let coercions = 0;
  const poison = { toString() { coercions++; return 'silently injected'; } };
  for (const replacement of [null, undefined, 17, ['safe'], poison]) {
    assert.throws(() => createMultiFileEditPlan({
      files: [{
        path: 'src/guarded.ts', expectedSha256: digest('original'),
        edits: [{ start: 0, end: 1, replacement } as any]
      }]
    }), /replacement must be literal text/);
  }
  assert.equal(coercions, 0, 'editing malformed input may not execute toString hooks');
  const empty = createMultiFileEditPlan({
    files: [{ path: 'src/guarded.ts', expectedSha256: digest('original'),
      edits: [{ start: 0, end: 1, replacement: '' }] }]
  });
  assert.equal(applyMultiFileEditPlan(empty, { 'src/guarded.ts': 'original' }).contentByPath['src/guarded.ts'], 'riginal');
});

test('C06 plan boundaries refuse coerced SHA, edit range and trusted command identity', () => {
  let conversions = 0;
  const spoof = { toString() { conversions++; return '1'; },
    valueOf() { conversions++; return 1; } };
  const make = (edit: any, expectedSha256: any = digest('abc'), verification: any = {}) =>
    createMultiFileEditPlan({ files: [{
      path: 'src/scope.ts', expectedSha256, edits: [edit]
    }], verification });
  const valid = { start: 0, end: 1, replacement: 'z' };
  for (const malformed of [
    { ...valid, start: '0' }, { ...valid, start: [0] },
    { ...valid, start: spoof }, { ...valid, end: '1' },
    { ...valid, end: [1] }, { ...valid, end: spoof }
  ]) assert.throws(() => make(malformed), /is invalid/);
  assert.throws(() => make(valid, [digest('abc')]), /must be SHA-256/);
  assert.throws(() => make(valid, spoof), /must be SHA-256/);
  assert.throws(() => make(valid, digest('abc'),
    { trustedCommandIds: [['typecheck']] }), /invalid id/);
  assert.throws(() => make(valid, digest('abc'),
    { trustedCommandIds: [spoof] }), /invalid id/);
  assert.equal(conversions, 0, 'untrusted values may not invoke conversion callbacks');
});

test('C06 edit-plan construction rejects sparse target or operation arrays', () => {
  const file = { path: 'src/counter.ts', expectedSha256: digest('before'),
    edits: [{ start: 0, end: 1, replacement: 'B' }] };
  const candidate = (files: any) => createMultiFileEditPlan({ files });
  for (const files of [
    new Array(1),
    [file, , file],
    Object.assign([file], { extra: 'hidden-authority' }),
    Object.defineProperty([file], 'shadow', { value: 'other-file' })
  ]) {
    assert.throws(() => candidate(files),
      (error: any) => error?.code === 'MULTI_FILE_EDIT_PLAN_INVALID');
  }
  for (const edits of [
    new Array(1),
    [{ start: 0, end: 1, replacement: 'B' }, , { start: 1, end: 2, replacement: 'X' }],
    Object.assign([...file.edits], { hidden: true })
  ]) {
    assert.throws(() => candidate([{ ...file, edits }]),
      (error: any) => error?.code === 'MULTI_FILE_EDIT_PLAN_INVALID');
  }
});

test('C06 edit-plan request and file/edit records must contain inert own fields only', () => {
  let callbackCount = 0;
  const file = { path: 'src/guarded.ts', expectedSha256: digest('original'),
    edits: [{ start: 0, end: 1, replacement: 'X' }] };
  const top = Object.defineProperty({ files: [file] }, 'files', {
    enumerable: true, get() { callbackCount++; return [file]; }
  });
  const accessorFile = Object.defineProperty({ ...file }, 'path', {
    enumerable: true, get() { callbackCount++; return file.path; }
  });
  const accessorEdit = Object.defineProperty({ ...file.edits[0] }, 'replacement', {
    enumerable: true, get() { callbackCount++; return 'forged edit'; }
  });
  const adversarial = [
    top,
    { files: [accessorFile] },
    { files: [{ ...file, edits: [accessorEdit] }] },
    { files: [Object.assign({ ...file }, { approvedBy: 'agent' })] },
    { files: [{ ...file, edits: [Object.defineProperty({ ...file.edits[0] },
      'token', { value: 'hidden' })] }] },
    Object.assign(Object.create({ files: [file] }), { verification: {} })
  ];
  for (const input of adversarial) {
    assert.throws(() => createMultiFileEditPlan(input as any),
      (error: any) => error?.code === 'MULTI_FILE_EDIT_PLAN_INVALID');
  }
  assert.equal(callbackCount, 0);
});

test('C06 edit verification lists reject executable or sparse command IDs and paths', () => {
  const file = { path: 'src/main.ts', expectedSha256: digest('text'),
    edits: [{ start: 0, end: 1, replacement: 'T' }] };
  let callbacks = 0;
  const getterList = Object.defineProperty(['typecheck'], '0', {
    enumerable: true, get() { callbacks++; return 'typecheck'; }
  });
  for (const verification of [
    { trustedCommandIds: new Array(1) },
    { requiredTestPaths: new Array(1) },
    { trustedCommandIds: getterList },
    { requiredTestPaths: Object.assign(['test/a.test.ts'], { hidden: true }) },
    Object.defineProperty({ trustedCommandIds: [] }, 'requiredTestPaths', {
      enumerable: true, get() { callbacks++; return []; }
    })
  ]) {
    assert.throws(() => createMultiFileEditPlan({ files: [file], verification: verification as any }),
      (error: any) => error?.code === 'MULTI_FILE_EDIT_PLAN_INVALID');
  }
  assert.equal(callbacks, 0);
});

test('C06 current content must be literal own data, never inherited or getter-backed', () => {
  const original = 'trusted';
  const plan = createMultiFileEditPlan({ files: [{
    path: 'src/data.txt', expectedSha256: digest(original),
    edits: [{ start: 0, end: 1, replacement: 'T' }]
  }] });
  let callbacks = 0;
  const getter = Object.defineProperty({}, 'src/data.txt', {
    enumerable: true, get() { callbacks++; return original; }
  });
  const inherited = Object.create({ 'src/data.txt': original });
  for (const source of [getter, inherited, {}]) {
    assert.throws(() => applyMultiFileEditPlan(plan, source as any),
      (error: any) => ['EDIT_PLAN_TARGET_MISSING','MULTI_FILE_EDIT_PLAN_INVALID'].includes(error?.code));
  }
  assert.equal(callbacks, 0);
  const next = applyMultiFileEditPlan(plan, { 'src/data.txt': original });
  assert.equal(next.contentByPath['src/data.txt'], 'Trusted');
});

test('C06 reserved JavaScript property names are ordinary literal file targets', () => {
  const original = 'true';
  const plan = createMultiFileEditPlan({ files: [{
    path: '__proto__', expectedSha256: digest(original),
    edits: [{ start: 0, end: 1, replacement: 'T' }]
  }] });
  const content = Object.create(null);
  content['__proto__'] = original;
  const result = applyMultiFileEditPlan(plan, content);
  assert.equal(Object.getPrototypeOf(result.contentByPath), null);
  assert.equal(Object.hasOwn(result.contentByPath, '__proto__'), true);
  assert.equal(result.contentByPath['__proto__'], 'True');
});

test('C06 immutable plan validation rejects an executable plan identity getter', () => {
  const p = createMultiFileEditPlan({ files: [{
    path: 'test.ts', expectedSha256: digest('code'),
    edits: [{ start: 0, end: 1, replacement: 'C' }]
  }] });
  let callbacks = 0;
  const forged = Object.defineProperty({ ...p }, 'id', {
    enumerable: true, get() { callbacks++; return p.id; }
  });
  assert.throws(() => validateMultiFileEditPlan(forged),
    (error: any) => error?.code === 'MULTI_FILE_EDIT_PLAN_INVALID');
  assert.equal(callbacks, 0);
});
