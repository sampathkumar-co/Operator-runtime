import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedGitDiff } from '../src/capabilities/git.ts';
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
