import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export interface TextEditOperation {
  start: number;
  end: number;
  replacement: string;
}

export interface MultiFileEditEntry {
  path: string;
  expectedSha256: string;
  edits: TextEditOperation[];
}

export interface EditVerificationContract {
  trustedCommandIds: string[];
  requiredTestPaths: string[];
}

export interface MultiFileEditPlan {
  schemaVersion: 1;
  id: string;
  files: MultiFileEditEntry[];
  verification: EditVerificationContract;
}

export interface EditFilePreview {
  path: string;
  beforeSha256: string;
  afterSha256: string;
  beforeBytes: number;
  afterBytes: number;
  beforeLines: number;
  afterLines: number;
  firstChangedLine: number | null;
  lastChangedLineBefore: number | null;
  lastChangedLineAfter: number | null;
}

export interface MultiFileEditPreview {
  planId: string;
  files: EditFilePreview[];
  totalBeforeBytes: number;
  totalAfterBytes: number;
}

export interface AppliedEditPlan {
  preview: MultiFileEditPreview;
  contentByPath: Record<string, string>;
}

const MAX_FILES = 1000;
const MAX_EDITS_PER_FILE = 10_000;
const MAX_REPLACEMENT_BYTES_PER_FILE = 8 * 1024 * 1024;
const MAX_CONTENT_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_VERIFICATION_ITEMS = 5000;

export function createMultiFileEditPlan(input: {
  files: Array<{
    path: string;
    expectedSha256: string;
    edits: TextEditOperation[];
  }>;
  verification?: Partial<EditVerificationContract>;
}): MultiFileEditPlan {
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    throw invalid(`Edit plan must contain 1-${MAX_FILES} files.`);
  }

  const seen = new Set<string>();
  const files = input.files.map((file) => {
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) throw invalid(`Duplicate edit target: ${relativePath}`);
    seen.add(relativePath);
    const expectedSha256 = digest(file.expectedSha256, 'expectedSha256');
    const edits = normalizeEdits(file.edits, relativePath);
    return { path: relativePath, expectedSha256, edits };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const verification: EditVerificationContract = {
    trustedCommandIds: uniqueBoundedIds(input.verification?.trustedCommandIds ?? [], 'trustedCommandIds'),
    requiredTestPaths: uniquePaths(input.verification?.requiredTestPaths ?? [], 'requiredTestPaths')
  };

  const identity = { schemaVersion: 1 as const, files, verification };
  return {
    ...identity,
    id: crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')
  };
}

export function applyMultiFileEditPlan(
  planInput: MultiFileEditPlan,
  currentContentByPath: Readonly<Record<string, string>>
): AppliedEditPlan {
  const plan = validateMultiFileEditPlan(planInput);
  if (!currentContentByPath || typeof currentContentByPath !== 'object' || Array.isArray(currentContentByPath)) {
    throw invalid('Current content map is invalid.');
  }

  const output: Record<string, string> = {};
  const previews: EditFilePreview[] = [];
  let totalBeforeBytes = 0;
  let totalAfterBytes = 0;

  for (const file of plan.files) {
    const current = currentContentByPath[file.path];
    if (typeof current !== 'string') {
      throw new OperatorError('EDIT_PLAN_TARGET_MISSING', `Current content is missing for ${file.path}.`);
    }
    const beforeBytes = Buffer.byteLength(current, 'utf8');
    if (beforeBytes > MAX_CONTENT_BYTES_PER_FILE) {
      throw invalid(`Current content exceeds byte budget for ${file.path}.`);
    }
    const beforeSha256 = sha256Text(current);
    if (beforeSha256 !== file.expectedSha256) {
      throw new OperatorError('EDIT_PLAN_STALE', `Edit target changed since planning: ${file.path}.`, {
        details: { path: file.path, expectedSha256: file.expectedSha256, actualSha256: beforeSha256 }
      });
    }

    validateEditBounds(current, file);
    const next = applyEdits(current, file.edits);
    const afterBytes = Buffer.byteLength(next, 'utf8');
    if (afterBytes > MAX_CONTENT_BYTES_PER_FILE) {
      throw invalid(`Edited content exceeds byte budget for ${file.path}.`);
    }

    output[file.path] = next;
    totalBeforeBytes += beforeBytes;
    totalAfterBytes += afterBytes;
    previews.push(previewFile(file.path, current, next));
  }

  return {
    preview: {
      planId: plan.id,
      files: previews,
      totalBeforeBytes,
      totalAfterBytes
    },
    contentByPath: output
  };
}

export function validateMultiFileEditPlan(input: MultiFileEditPlan): MultiFileEditPlan {
  if (!input || input.schemaVersion !== 1 || typeof input.id !== 'string') {
    throw invalid('Edit plan shape is invalid.');
  }
  const normalized = createMultiFileEditPlan({
    files: input.files,
    verification: input.verification
  });
  if (normalized.id !== input.id) {
    throw invalid('Edit plan id does not match its immutable content.');
  }
  return normalized;
}

function normalizeEdits(input: unknown, target: string): TextEditOperation[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_EDITS_PER_FILE) {
    throw invalid(`Edits for ${target} are invalid.`);
  }
  let replacementBytes = 0;
  const edits = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid(`Edit ${index} for ${target} is invalid.`);
    }
    const raw = item as Record<string, unknown>;
    const start = integer(raw.start, 0, Number.MAX_SAFE_INTEGER, 'start');
    const end = integer(raw.end, start, Number.MAX_SAFE_INTEGER, 'end');
    const replacement = String(raw.replacement ?? '');
    if (replacement.includes('\0')) throw invalid('Edit replacement may not contain NUL.');
    replacementBytes += Buffer.byteLength(replacement, 'utf8');
    if (replacementBytes > MAX_REPLACEMENT_BYTES_PER_FILE) {
      throw invalid(`Replacement budget exceeded for ${target}.`);
    }
    return { start, end, replacement };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  let previousEnd = -1;
  for (const edit of edits) {
    if (edit.start < previousEnd) {
      throw new OperatorError('EDIT_PLAN_OVERLAP', `Edit ranges overlap for ${target}.`);
    }
    previousEnd = edit.end;
  }
  return edits;
}

function validateEditBounds(current: string, file: MultiFileEditEntry): void {
  for (const edit of file.edits) {
    if (edit.start > current.length || edit.end > current.length) {
      throw new OperatorError('EDIT_PLAN_RANGE_INVALID', `Edit range exceeds current content for ${file.path}.`);
    }
    if (splitsSurrogatePair(current, edit.start) || splitsSurrogatePair(current, edit.end)) {
      throw new OperatorError('EDIT_PLAN_UNICODE_BOUNDARY', `Edit range splits a Unicode surrogate pair for ${file.path}.`);
    }
  }
}

function applyEdits(current: string, edits: TextEditOperation[]): string {
  let output = current;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

function previewFile(pathValue: string, before: string, after: string): EditFilePreview {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;

  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix &&
    afterSuffix >= prefix &&
    beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const changed = before !== after;
  return {
    path: pathValue,
    beforeSha256: sha256Text(before),
    afterSha256: sha256Text(after),
    beforeBytes: Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8'),
    beforeLines: beforeLines.length,
    afterLines: afterLines.length,
    firstChangedLine: changed ? prefix + 1 : null,
    lastChangedLineBefore: changed ? Math.max(prefix + 1, beforeSuffix + 1) : null,
    lastChangedLineAfter: changed ? Math.max(prefix + 1, afterSuffix + 1) : null
  };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF;
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) {
    throw invalid('Edit target path is invalid.');
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw invalid('Edit target must be a relative path inside the workspace.');
  }
  return normalized;
}

function uniquePaths(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > MAX_VERIFICATION_ITEMS) throw invalid(`${label} is invalid.`);
  return [...new Set(input.map(normalizeRelativePath))].sort();
}

function uniqueBoundedIds(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > MAX_VERIFICATION_ITEMS) throw invalid(`${label} is invalid.`);
  const values = input.map((item) => {
    const value = String(item ?? '');
    if (!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(value)) throw invalid(`${label} contains an invalid id.`);
    return value;
  });
  return [...new Set(values)].sort();
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(`${label} must be SHA-256.`);
  return value;
}

function integer(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is invalid.`);
  return value;
}

function invalid(message: string): OperatorError {
  return new OperatorError('MULTI_FILE_EDIT_PLAN_INVALID', message);
}
