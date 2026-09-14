import assert from 'node:assert/strict';
import test from 'node:test';
import { currentMcpTaskId, withMcpInvocation } from '../src/request-context.ts';

test('MCP invocation identity is deterministic for retry and distinct across request or scope', async () => {
  const task = async (id: string | number, scope: string) => await withMcpInvocation(
    { jsonrpc: '2.0', id, method: 'tools/call' },
    scope,
    async () => {
      await Promise.resolve();
      return currentMcpTaskId();
    }
  );

  const first = await task(41, 'oauth-client:client-a');
  assert.match(first ?? '', /^mcp-request-[0-9a-f]{64}$/);
  assert.equal(await task(41, 'oauth-client:client-a'), first);
  assert.notEqual(await task(42, 'oauth-client:client-a'), first);
  assert.notEqual(await task(41, 'oauth-client:client-b'), first);
  assert.equal(withMcpInvocation({ method: 'tools/list' }, 'oauth-client:client-a', () => currentMcpTaskId()), undefined);
});
