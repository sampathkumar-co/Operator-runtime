import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperatorError } from './errors.ts';
import {
  createMultiFileEditPlan,
  type MultiFileEditPlan,
  type TextEditOperation
} from './multi-file-edit-plan.ts';
import { WorkspaceCodeIndexer, type ImpactResult } from './workspace-code-index.ts';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
  annotationId?: string;
}

export interface LspTextDocumentIdentifier {
  uri: string;
  version?: number | null;
}

export interface LspTextDocumentEdit {
  textDocument: LspTextDocumentIdentifier;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | Record<string, unknown>>;
  changeAnnotations?: Record<string, unknown>;
}

export interface LspWorkspaceEditEnvelope {
  workspaceRoot: string;
  edit: LspWorkspaceEdit;
  expectedDocumentSha256: Record<string, string>;
  trustedCommandIds?: string[];
  includeImpactAnalysis?: boolean;
}

export interface ResolvedLspWorkspaceEdit {
  plan: MultiFileEditPlan;
  changedPaths: string[];
  impact?: ImpactResult;
}

const MAX_FILES = 1000;
const MAX_EDITS = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_NEW_TEXT_BYTES = 8 * 1024 * 1024;

export async function resolveLspWorkspaceEdit(
  input: LspWorkspaceEditEnvelope
): Promise<ResolvedLspWorkspaceEdit> {
  const workspaceRoot = await resolveWorkspaceRoot(input.workspaceRoot);
  const normalized = normalizeWorkspaceEdit(input.edit);
  if (normalized.size < 1) {
    throw invalid('LSP WorkspaceEdit contains no text edits.');
  }
  if (normalized.size > MAX_FILES) {
    throw invalid('LSP WorkspaceEdit exceeds the file-count bound.');
  }

  const files: Array<{
    path: string;
    expectedSha256: string;
    edits: TextEditOperation[];
  }> = [];

  for (const [uri, edits] of [...normalized.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const expectedSha256 = normalizeDigest(input.expectedDocumentSha256?.[uri], uri);
    const target = await resolveDocumentUri(workspaceRoot, uri);
    const bytes = await fs.readFile(target.absolutePath);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw invalid('LSP document exceeds the file byte limit.', { uri });
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw invalid('LSP document must be valid UTF-8.', { uri });
    }
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== expectedSha256) {
      throw new OperatorError(
        'LSP_WORKSPACE_EDIT_STALE',
        'LSP WorkspaceEdit was produced for stale document bytes.',
        {
          details: {
            uri,
            expectedSha256,
            actualSha256
          }
        }
      );
    }

    const operations = edits.map((edit, index) =>
      convertTextEdit(text, edit, uri, index)
    );
    files.push({
      path: target.relativePath,
      expectedSha256,
      edits: operations
    });
  }

  let requiredTestPaths: string[] = [];
  let impact: ImpactResult | undefined;
  if (input.includeImpactAnalysis !== false) {
    const indexer = new WorkspaceCodeIndexer(workspaceRoot);
    const snapshot = await indexer.build();
    const indexed = new Set(snapshot.files.map((file) => file.path));
    const changedPaths = files.map((file) => file.path);
    const indexedChanged = changedPaths.filter((item) => indexed.has(item));
    if (indexedChanged.length > 0) {
      impact = indexer.impact(snapshot, indexedChanged);
      requiredTestPaths = impact.suggestedTestPaths;
    }
  }

  const plan = createMultiFileEditPlan({
    files,
    verification: {
      trustedCommandIds: input.trustedCommandIds ?? [],
      requiredTestPaths
    }
  });

  return {
    plan,
    changedPaths: files.map((file) => file.path),
    ...(impact ? { impact } : {})
  };
}

function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw invalid('LSP WorkspaceEdit must be an object.');
  }
  if (edit.changeAnnotations && Object.keys(edit.changeAnnotations).length > 0) {
    throw new OperatorError(
      'LSP_CHANGE_ANNOTATION_UNSUPPORTED',
      'LSP change annotations require an explicit approval UX and are not accepted by this resolver.'
    );
  }
  if (edit.changes && edit.documentChanges) {
    throw invalid('LSP WorkspaceEdit may not contain both changes and documentChanges.');
  }

  const output = new Map<string, LspTextEdit[]>();
  let editCount = 0;
  const append = (uri: string, edits: unknown): void => {
    const normalizedUri = normalizeFileUri(uri);
    if (!Array.isArray(edits) || edits.length < 1) {
      throw invalid('LSP text edit list must contain at least one edit.', { uri: normalizedUri });
    }
    const bucket = output.get(normalizedUri) ?? [];
    for (const item of edits) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw invalid('LSP text edit entry is invalid.', { uri: normalizedUri });
      }
      const raw = item as Record<string, unknown>;
      if (raw.annotationId !== undefined) {
        throw new OperatorError(
          'LSP_CHANGE_ANNOTATION_UNSUPPORTED',
          'Annotated LSP edits require explicit approval handling and are not accepted by this resolver.'
        );
      }
      const newText = String(raw.newText ?? '');
      if (Buffer.byteLength(newText, 'utf8') > MAX_NEW_TEXT_BYTES) {
        throw invalid('LSP replacement text exceeds the byte bound.', { uri: normalizedUri });
      }
      bucket.push({
        range: normalizeRange(raw.range, normalizedUri),
        newText
      });
      editCount += 1;
      if (editCount > MAX_EDITS) throw invalid('LSP WorkspaceEdit exceeds the edit-count bound.');
    }
    output.set(normalizedUri, bucket);
  };

  if (edit.changes) {
    if (!edit.changes || typeof edit.changes !== 'object' || Array.isArray(edit.changes)) {
      throw invalid('LSP changes map is invalid.');
    }
    for (const [uri, edits] of Object.entries(edit.changes)) append(uri, edits);
    return output;
  }

  if (edit.documentChanges) {
    if (!Array.isArray(edit.documentChanges)) throw invalid('LSP documentChanges is invalid.');
    for (const change of edit.documentChanges) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw invalid('LSP document change is invalid.');
      }
      const raw = change as Record<string, unknown>;
      if ('kind' in raw) {
        throw new OperatorError(
          'LSP_RESOURCE_OPERATION_UNSUPPORTED',
          'LSP create/rename/delete resource operations are not accepted by the structural edit resolver.'
        );
      }
      const textDocument = raw.textDocument;
      if (!textDocument || typeof textDocument !== 'object' || Array.isArray(textDocument)) {
        throw invalid('LSP TextDocumentEdit requires textDocument.');
      }
      const uri = String((textDocument as Record<string, unknown>).uri ?? '');
      append(uri, raw.edits);
    }
  }
  return output;
}

function normalizeRange(input: unknown, uri: string): LspRange {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('LSP edit range is invalid.', { uri });
  }
  const raw = input as Record<string, unknown>;
  return {
    start: normalizePosition(raw.start, 'start', uri),
    end: normalizePosition(raw.end, 'end', uri)
  };
}

function normalizePosition(input: unknown, label: string, uri: string): LspPosition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('LSP position is invalid.', { uri, label });
  }
  const raw = input as Record<string, unknown>;
  const line = Number(raw.line);
  const character = Number(raw.character);
  if (!Number.isSafeInteger(line) || line < 0 || line > 10_000_000) {
    throw invalid('LSP line is invalid.', { uri, label });
  }
  if (!Number.isSafeInteger(character) || character < 0 || character > 100_000_000) {
    throw invalid('LSP character is invalid.', { uri, label });
  }
  return { line, character };
}

function convertTextEdit(
  text: string,
  edit: LspTextEdit,
  uri: string,
  index: number
): TextEditOperation {
  const starts = lineStarts(text);
  const start = offsetForPosition(text, starts, edit.range.start, uri, index, 'start');
  const end = offsetForPosition(text, starts, edit.range.end, uri, index, 'end');
  if (end < start) {
    throw invalid('LSP edit range ends before it starts.', { uri, index });
  }
  return {
    start,
    end,
    replacement: edit.newText
  };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function offsetForPosition(
  text: string,
  starts: number[],
  position: LspPosition,
  uri: string,
  index: number,
  endpoint: 'start' | 'end'
): number {
  if (position.line >= starts.length) {
    throw invalid('LSP position line exceeds the document.', { uri, index, endpoint });
  }
  const lineStart = starts[position.line]!;
  const nextStart = starts[position.line + 1] ?? text.length;
  let lineEnd = nextStart;
  while (
    lineEnd > lineStart &&
    (text.charCodeAt(lineEnd - 1) === 10 || text.charCodeAt(lineEnd - 1) === 13)
  ) {
    lineEnd -= 1;
  }
  const lineLength = lineEnd - lineStart;
  if (position.character > lineLength) {
    throw invalid('LSP character exceeds the UTF-16 line length.', {
      uri,
      index,
      endpoint,
      lineLength
    });
  }
  const offset = lineStart + position.character;
  if (splitsSurrogatePair(text, offset)) {
    throw new OperatorError(
      'LSP_UTF16_BOUNDARY_INVALID',
      'LSP position splits a UTF-16 surrogate pair.',
      { details: { uri, index, endpoint } }
    );
  }
  return offset;
}

async function resolveWorkspaceRoot(input: string): Promise<string> {
  const lexical = path.resolve(String(input ?? ''));
  const stat = await fs.lstat(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw invalid('workspaceRoot must be a real directory.');
  }
  return await fs.realpath(lexical);
}

async function resolveDocumentUri(
  workspaceRoot: string,
  uriInput: string
): Promise<{ absolutePath: string; relativePath: string }> {
  const uri = normalizeFileUri(uriInput);
  let lexical: string;
  try {
    lexical = path.resolve(fileURLToPath(uri));
  } catch {
    throw invalid('LSP document URI is not a valid file URI.', { uri });
  }
  const stat = await fs.lstat(lexical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new OperatorError(
      'LSP_DOCUMENT_TOPOLOGY_UNSAFE',
      'LSP structural edit targets must be singly linked regular files.',
      { details: { uri } }
    );
  }
  const real = await fs.realpath(lexical);
  if (!inside(real, workspaceRoot)) {
    throw new OperatorError(
      'LSP_DOCUMENT_OUTSIDE_WORKSPACE',
      'LSP document resolves outside workspaceRoot.',
      { details: { uri } }
    );
  }
  return {
    absolutePath: real,
    relativePath: toPosix(path.relative(workspaceRoot, real))
  };
}

function normalizeFileUri(input: unknown): string {
  const text = String(input ?? '');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw invalid('LSP document URI is invalid.');
  }
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid('Only plain file:// LSP document URIs are supported.');
  }
  return parsed.href;
}

function normalizeDigest(input: unknown, uri: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw invalid('Every edited LSP document requires an expected SHA-256.', { uri });
  }
  return value;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xD800 && previous <= 0xDBFF &&
    next >= 0xDC00 && next <= 0xDFFF;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function invalid(message: string, details?: Record<string, unknown>): OperatorError {
  return new OperatorError('LSP_WORKSPACE_EDIT_INVALID', message, { details });
}
