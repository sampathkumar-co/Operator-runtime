import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_AGENT_DEFAULT_ALLOWED_CAPABILITIES } from '../apps/local-agent/src/default-permissions.ts';

test('local agent explicitly authorizes workspace edit and Developer Worktree capabilities', () => {
  const allowed = new Set<string>(LOCAL_AGENT_DEFAULT_ALLOWED_CAPABILITIES);
  for (const capability of [
    'workspace.edit.resolve_lsp',
    'workspace.edit.transaction',
    'developer.worktree.create',
    'developer.worktree.inspect',
    'developer.worktree.release'
  ]) {
    assert.equal(allowed.has(capability), true, capability);
  }
  assert.equal(allowed.has('workspace.*'), false);
  assert.equal(allowed.has('developer.*'), false);
});
