import assert from 'node:assert/strict';
import test from 'node:test';
import { currentMcpTaskId, mcpInvocationScope, withMcpInvocation } from '../src/request-context.ts';

test('MCP invocation identity is deterministic for retry and distinct across request or scope', async () => {
  const task = async (id: string | number, scope: string) => await withMcpInvocation(
    { jsonrpc: '2.0', id, method: 'tools/call' },
    scope,
    async () => {
      await Promise.resolve();
      return currentMcpTaskId();
    }
  );

  const sessionA = mcpInvocationScope('session-a', 'client-a');
  const sessionB = mcpInvocationScope('session-b', 'client-a');
  const first = await task(41, sessionA);
  assert.match(first ?? '', /^mcp-request-[0-9a-f]{64}$/);
  assert.equal(await task(41, sessionA), first);
  assert.notEqual(await task(42, sessionA), first);
  assert.notEqual(await task(41, sessionB), first);
  assert.notEqual(await task(41, mcpInvocationScope('session-a', 'client-b')), first);
  assert.equal(withMcpInvocation({ method: 'tools/list' }, sessionA, () => currentMcpTaskId()), undefined);
});
