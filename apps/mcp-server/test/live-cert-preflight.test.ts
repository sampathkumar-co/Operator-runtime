import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_NAMES } from '../src/tool-surface.ts';
import { requireLocalMcpUrl, validateAndFingerprintTools } from '../scripts/live-cert-preflight.ts';

function fakeTools(reverse = false) {
  const tools = TOOL_NAMES.map((name) => ({
    name,
    annotations: {
      readOnlyHint: name.endsWith('.inspect') || ['file.read', 'file.list', 'git.status', 'git.diff', 'postgres.query', 'browser.navigate'].includes(name),
      destructiveHint: ['project.transaction', 'git.checkpoint', 'terminal.execute'].includes(name),
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'boolean' } } }
  }));
  return reverse ? tools.reverse() : tools;
}

test('local certification URL is loopback-only and credential-free', () => {
  assert.equal(requireLocalMcpUrl('http://127.0.0.1:47200/mcp').pathname, '/mcp');
  assert.equal(requireLocalMcpUrl('http://[::1]:47200/mcp').hostname, '[::1]');
  assert.throws(() => requireLocalMcpUrl('https://127.0.0.1/mcp'), /loopback HTTP/);
  assert.throws(() => requireLocalMcpUrl('http://localhost:47200/mcp'), /literal loopback/);
  assert.throws(() => requireLocalMcpUrl('http://user:pass@127.0.0.1:47200/mcp'), /must not embed credentials/);
  assert.throws(() => requireLocalMcpUrl('http://127.0.0.1:47200/mcp?token=secret'), /query or fragment/);
});

test('tool-surface fingerprint is stable across enumeration and object-key order', () => {
  const first = validateAndFingerprintTools(fakeTools());
  const second = validateAndFingerprintTools(fakeTools(true).map((tool) => ({
    ...tool,
    inputSchema: { properties: { a: { type: 'boolean' }, z: { type: 'string' } }, type: 'object' }
  })));
  assert.equal(first.count, 22);
  assert.deepEqual(first.names, TOOL_NAMES);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
});

test('tool-surface validation fails closed on drift, duplicates, or missing annotations', () => {
  assert.throws(() => validateAndFingerprintTools(fakeTools().slice(1)), /drifted from the canonical Operator surface/);
  const duplicate = [...fakeTools(), fakeTools()[0]];
  assert.throws(() => validateAndFingerprintTools(duplicate), /duplicate names/);
  const missingAnnotation = fakeTools();
  delete (missingAnnotation[0].annotations as Record<string, unknown>).openWorldHint;
  assert.throws(() => validateAndFingerprintTools(missingAnnotation), /missing boolean annotation openWorldHint/);
});