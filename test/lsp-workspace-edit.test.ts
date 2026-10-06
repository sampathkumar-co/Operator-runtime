import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveLspWorkspaceEdit } from '../src/core/lsp-workspace-edit.ts';

function digest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function tempWorkspace(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-lsp-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('LSP WorkspaceEdit resolves UTF-16 ranges into immutable SHA-bound multi-file edits with impact hints', async (t) => {
  const root = await tempWorkspace(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });

  const util = [
    "export const emoji = '😀';",
    'export function value() { return 1; }',
    ''
  ].join('\n');
  const main = [
    "import { value } from './util';",
    'export const result = value();',
    ''
  ].join('\n');
  const spec = [
    "import { result } from '../src/main';",
    'export function resultTest() { return result; }',
    ''
  ].join('\n');

  const utilPath = path.join(root, 'src', 'util.ts');
  const mainPath = path.join(root, 'src', 'main.ts');
  const specPath = path.join(root, 'test', 'main.test.ts');
  await fs.writeFile(utilPath, util);
  await fs.writeFile(mainPath, main);
  await fs.writeFile(specPath, spec);

  const utilUri = pathToFileURL(utilPath).href;
  const mainUri = pathToFileURL(mainPath).href;

  const resolved = await resolveLspWorkspaceEdit({
    workspaceRoot: root,
    expectedDocumentSha256: {
      [utilUri]: digest(util),
      [mainUri]: digest(main)
    },
    trustedCommandIds: ['test'],
    edit: {
      documentChanges: [
        {
          textDocument: { uri: utilUri, version: 7 },
          edits: [{
            range: {
              start: { line: 1, character: 34 },
              end: { line: 1, character: 35 }
            },
            newText: '2'
          }]
        },
        {
          textDocument: { uri: mainUri, version: 3 },
          edits: [{
            range: {
              start: { line: 1, character: 13 },
              end: { line: 1, character: 19 }
            },
            newText: 'answer'
          }]
        }
      ]
    }
  });

  assert.deepEqual(resolved.changedPaths, ['src/main.ts', 'src/util.ts']);
  assert.equal(resolved.plan.files.length, 2);
  assert.deepEqual(resolved.plan.verification.trustedCommandIds, ['test']);
  assert.ok(resolved.impact);
  assert.ok(resolved.impact!.impactedPaths.includes('test/main.test.ts'));
  assert.ok(resolved.plan.verification.requiredTestPaths.includes('test/main.test.ts'));

  const utilPlan = resolved.plan.files.find((file) => file.path === 'src/util.ts');
  assert.equal(utilPlan?.expectedSha256, digest(util));
  assert.deepEqual(utilPlan?.edits, [{
    start: util.indexOf('1'),
    end: util.indexOf('1') + 1,
    replacement: '2'
  }]);
});

test('LSP resolver rejects stale document digests before creating an edit plan', async (t) => {
  const root = await tempWorkspace(t);
  const file = path.join(root, 'a.ts');
  const text = 'export const value = 1;\n';
  await fs.writeFile(file, text);
  const uri = pathToFileURL(file).href;

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: 'a'.repeat(64) },
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
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_WORKSPACE_EDIT_STALE');
      return true;
    }
  );
  assert.equal(await fs.readFile(file, 'utf8'), text);
});

test('LSP resolver rejects document URIs outside workspaceRoot', async (t) => {
  const parent = await tempWorkspace(t);
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);
  const outside = path.join(parent, 'outside.ts');
  const text = 'export const outside = true;\n';
  await fs.writeFile(outside, text);
  const uri = pathToFileURL(outside).href;

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: digest(text) },
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 }
            },
            newText: '// no\n'
          }]
        }
      }
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_DOCUMENT_OUTSIDE_WORKSPACE');
      return true;
    }
  );
});

test('LSP resolver rejects annotations and resource operations instead of silently dropping semantics', async (t) => {
  const root = await tempWorkspace(t);
  const file = path.join(root, 'a.ts');
  const text = 'export const value = 1;\n';
  await fs.writeFile(file, text);
  const uri = pathToFileURL(file).href;

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: digest(text) },
      edit: {
        changeAnnotations: { review: { label: 'Needs review' } },
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 }
            },
            newText: '// x\n'
          }]
        }
      }
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_CHANGE_ANNOTATION_UNSUPPORTED');
      return true;
    }
  );

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: {},
      edit: {
        documentChanges: [{
          kind: 'create',
          uri: pathToFileURL(path.join(root, 'new.ts')).href
        }]
      }
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_RESOURCE_OPERATION_UNSUPPORTED');
      return true;
    }
  );
});

test('LSP UTF-16 positions may not split a surrogate pair', async (t) => {
  const root = await tempWorkspace(t);
  const file = path.join(root, 'emoji.ts');
  const text = "export const icon = '😀';\n";
  await fs.writeFile(file, text);
  const uri = pathToFileURL(file).href;
  const emojiStart = text.indexOf('😀');

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: digest(text) },
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: emojiStart + 1 },
              end: { line: 0, character: emojiStart + 1 }
            },
            newText: 'x'
          }]
        }
      }
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_UTF16_BOUNDARY_INVALID');
      return true;
    }
  );
});

test('LSP CRLF line mapping resolves offsets without consuming line terminators', async (t) => {
  const root = await tempWorkspace(t);
  const file = path.join(root, 'crlf.ts');
  const text = 'const a = 1;\r\nconst b = 2;\r\n';
  await fs.writeFile(file, text);
  const uri = pathToFileURL(file).href;

  const resolved = await resolveLspWorkspaceEdit({
    workspaceRoot: root,
    expectedDocumentSha256: { [uri]: digest(text) },
    includeImpactAnalysis: false,
    edit: {
      changes: {
        [uri]: [{
          range: {
            start: { line: 1, character: 10 },
            end: { line: 1, character: 11 }
          },
          newText: '3'
        }]
      }
    }
  });

  const edit = resolved.plan.files[0]!.edits[0]!;
  assert.equal(text.slice(edit.start, edit.end), '2');
});

test('LSP resolver rejects hard-linked documents because physical ownership is ambiguous', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Hard-link topology semantics are validated on POSIX CI.');
    return;
  }
  const parent = await tempWorkspace(t);
  const root = path.join(parent, 'workspace');
  await fs.mkdir(root);
  const outside = path.join(parent, 'outside.ts');
  const linked = path.join(root, 'linked.ts');
  const text = 'export const linked = true;\n';
  await fs.writeFile(outside, text);
  await fs.link(outside, linked);
  const uri = pathToFileURL(linked).href;

  await assert.rejects(
    () => resolveLspWorkspaceEdit({
      workspaceRoot: root,
      expectedDocumentSha256: { [uri]: digest(text) },
      edit: {
        changes: {
          [uri]: [{
            range: {
              start: { line: 0, character: 22 },
              end: { line: 0, character: 26 }
            },
            newText: 'false'
          }]
        }
      }
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LSP_DOCUMENT_TOPOLOGY_UNSAFE');
      return true;
    }
  );
});
