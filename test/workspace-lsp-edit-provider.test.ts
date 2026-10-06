import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { WorkspaceLspEditProvider } from '../src/capabilities/workspace-lsp-edit.ts';
import type { ActionRequest } from '../src/core/types.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('LSP edit provider returns an immutable plan without mutating workspace bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lsp-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'value.ts');
  const before = 'export const value = 1;\n';
  await fs.writeFile(file, before);
  const uri = pathToFileURL(file).href;

  const provider = new WorkspaceLspEditProvider({ allowedRoots: [root] });
  const action: ActionRequest = {
    id: 'lsp-plan-1',
    capability: 'workspace.edit.resolve_lsp',
    risk: 'read',
    input: {
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: digest(before) },
      includeImpactAnalysis: false,
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: 21 },
              end: { line: 0, character: 22 }
            },
            newText: '2'
          }]
        }
      }
    },
    provenance: { kind: 'runtime' }
  };

  const result = await provider.execute(action);
  assert.equal(result.ok, true);
  const output = result.output as {
    mutationPerformed?: boolean;
    plan?: { id?: string; files?: Array<{ path?: string }> };
  };
  assert.equal(output.mutationPerformed, false);
  assert.match(output.plan?.id ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(output.plan?.files?.map((item) => item.path), ['value.ts']);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('LSP edit provider reports stale input as pre-dispatch with no side effect', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lsp-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'value.ts');
  const before = 'export const value = 1;\n';
  await fs.writeFile(file, before);
  const uri = pathToFileURL(file).href;

  const provider = new WorkspaceLspEditProvider({ allowedRoots: [root] });
  const result = await provider.execute({
    id: 'lsp-plan-stale',
    capability: 'workspace.edit.resolve_lsp',
    risk: 'read',
    input: {
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: 'a'.repeat(64) },
      includeImpactAnalysis: false,
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: 21 },
              end: { line: 0, character: 22 }
            },
            newText: '2'
          }]
        }
      }
    },
    provenance: { kind: 'runtime' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'LSP_WORKSPACE_EDIT_STALE');
  assert.equal(result.error?.sideEffectState, 'none');
  assert.equal(result.error?.executionPhase, 'pre_dispatch');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('LSP edit provider rejects workspace roots outside configured authority scope', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lsp-provider-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const allowed = path.join(parent, 'allowed');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);

  const provider = new WorkspaceLspEditProvider({ allowedRoots: [allowed] });
  const result = await provider.execute({
    id: 'lsp-plan-outside',
    capability: 'workspace.edit.resolve_lsp',
    risk: 'read',
    input: {
      workspaceRoot: outside,
      expectedDocumentSha256: {},
      edit: { changes: {} }
    },
    provenance: { kind: 'runtime' }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.sideEffectState, 'none');
});
