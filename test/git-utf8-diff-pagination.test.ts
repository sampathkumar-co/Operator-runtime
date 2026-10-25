import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedGitDiff, structuredGitStatus } from '../src/capabilities/git.ts';
import type { ActionResult } from '../src/core/types.ts';

function result(stdout: string): ActionResult {
  return {
    ok: true,
    capability: 'git.diff',
    provider: 'git.native',
    evidence: [],
    durationMs: 0,
    output: { stdout, stderr: '', truncated: false }
  };
}

test('C06 Git diff byte pagination never cuts UTF-8 emoji or multilingual codepoints', () => {
  const body = 'a'.repeat(1022) + '🤖' + 'ภาษาไทย' + 'Z'.repeat(80);
  const raw = result(body);
  const first = boundedGitDiff(raw, { offset: 0, maxBytes: 1024 }).output as any;
  assert.equal(first.returnedBytes, 1022);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 1022);
  assert.equal(first.stdout, 'a'.repeat(1022));
  const second = boundedGitDiff(raw, { offset: first.nextOffset, maxBytes: 1024 }).output as any;
  assert.equal(first.stdout + second.stdout, body);
  assert.equal(second.truncated, false);
  assert.equal(Buffer.byteLength(first.stdout, 'utf8') + Buffer.byteLength(second.stdout, 'utf8'), Buffer.byteLength(body, 'utf8'));
  assert.ok(!JSON.stringify([first, second]).includes('�'));
});

test('C06 invalid mid-codepoint byte offsets reject rather than emit corrupted diffs', () => {
  const raw = result('a'.repeat(1022) + '🤖' + 'tail');
  for (const offset of [1023, 1024, 1025]) {
    assert.throws(() => boundedGitDiff(raw, { offset, maxBytes: 1024 }),
      (error: any) => error?.code === 'GIT_INPUT_INVALID');
  }
  assert.equal((boundedGitDiff(raw, { offset: 1026, maxBytes: 1024 }).output as any).stdout, 'tail');
});

test('C06 ASCII-only Git diff preserves existing byte offset and pagination behavior', () => {
  const raw = result('x'.repeat(1200));
  const first = boundedGitDiff(raw, { maxBytes: 1024 }).output as any;
  assert.equal(first.returnedBytes, 1024);
  assert.equal(first.nextOffset, 1024);
  const last = boundedGitDiff(raw, { offset: first.nextOffset, maxBytes: 1024 }).output as any;
  assert.equal(first.stdout + last.stdout, 'x'.repeat(1200));
  assert.equal(last.returnedBytes, 176);
});

test('C06 incomplete subprocess diff cannot masquerade as a paginated complete result', () => {
  const incomplete = { ...result('x'.repeat(4096)), output: {
    stdout: 'x'.repeat(4096), truncated: true, stderr: 'private details'
  } };
  for (const offset of [0, 1024, 4096]) {
    const answer = boundedGitDiff(incomplete, { offset, maxBytes: 1024 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, 'GIT_DIFF_SOURCE_TRUNCATED');
    assert.equal(answer.error?.retryable, false);
    const output = answer.output as any;
    assert.equal(output.stdout, '');
    assert.equal(output.returnedBytes, 0);
    assert.equal(output.nextOffset, undefined);
  }
});

test('C06 a truncated status subprocess cannot falsely declare success or paginate forever', () => {
  const incomplete = { ...result(''), capability: 'git.status', output: {
    stdout: '## main\0?? partial', truncated: true, stderr: 'sensitive data'
  } };
  for (const offset of [0, 1, 1000]) {
    const answer = structuredGitStatus(incomplete, { offset, maxBytes: 1024 });
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, 'GIT_STATUS_SOURCE_TRUNCATED');
    assert.equal(answer.error?.retryable, false);
    const output = answer.output as any;
    assert.equal(output.clean, false);
    assert.deepEqual(output.entries, []);
    assert.equal(output.nextOffset, undefined);
    assert.ok(!JSON.stringify(answer).includes('sensitive data'));
  }
});

test('C06 an oversized status record cannot return a non-progressing page cursor', () => {
  const longName = 'x'.repeat(3000);
  const source = { ...result(''), capability: 'git.status', output: {
    stdout: '## main\0?? ' + longName + '\0', truncated: false
  } };
  const answer = structuredGitStatus(source, { offset: 0, maxBytes: 1024 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error?.code, 'GIT_STATUS_ENTRY_TOO_LARGE');
  assert.equal(answer.error?.retryable, false);
  assert.equal((answer.output as any).nextOffset, undefined);
  const sufficient = structuredGitStatus(source, { offset: 0, maxBytes: 8192 });
  assert.equal(sufficient.ok, true);
  assert.equal((sufficient.output as any).entries.length, 1);
  assert.equal((sufficient.output as any).truncated, false);
});
