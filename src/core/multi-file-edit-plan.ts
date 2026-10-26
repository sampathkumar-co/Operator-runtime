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

/**
 * A plan is a candidate for filesystem writes, so proof-bearing arrays and
 * objects must consist only of enumerable own data. Native Array.map skips
 * holes, allowing a malformed plan to silently omit a requested target/edit.
 */
function inertArray(input: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length < min || input.length > max ||
      Reflect.ownKeys(input).length !== input.length + 1) {
    throw invalid(`${label} must be a dense bounded array.`);
  }
  const values: unknown[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalid(`${label} contains an absent or executable entry.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function inertRecord(input: unknown, required: readonly string[], allowed: readonly string[], label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw invalid(`${label} must be an inert plain record.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(descriptors, key))) {
    throw invalid(`${label} has missing or unsupported fields.`);
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw invalid(`${label} contains an accessor or hidden field.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

export function createMultiFileEditPlan(input: {
  files: Array<{
    path: string;
    expectedSha256: string;
    edits: TextEditOperation[];
  }>;
  verification?: Partial<EditVerificationContract>;
}): MultiFileEditPlan {
  const envelope = inertRecord(input, ['files'], ['files', 'verification'], 'Edit plan request');
  const sourceFiles = inertArray(envelope.files, 1, MAX_FILES, 'Edit plan files');

  const seen = new Set<string>();
  const files = sourceFiles.map((raw) => {
    const file = inertRecord(raw, ['path', 'expectedSha256', 'edits'],
      ['path', 'expectedSha256', 'edits'], 'Edit plan file');
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) throw invalid(`Duplicate edit target: ${relativePath}`);
    seen.add(relativePath);
    const expectedSha256 = digest(file.expectedSha256, 'expectedSha256');
    const edits = normalizeEdits(file.edits, relativePath);
    return { path: relativePath, expectedSha256, edits };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const sourceVerification = envelope.verification === undefined
    ? {} : inertRecord(envelope.verification, [],
      ['trustedCommandIds', 'requiredTestPaths'], 'Edit plan verification');
  const verification: EditVerificationContract = {
    trustedCommandIds: uniqueBoundedIds(sourceVerification.trustedCommandIds ?? [], 'trustedCommandIds'),
    requiredTestPaths: uniquePaths(sourceVerification.requiredTestPaths ?? [], 'requiredTestPaths')
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
  if (!currentContentByPath || typeof currentContentByPath !== 'object' || Array.isArray(currentContentByPath) ||
      (Object.getPrototypeOf(currentContentByPath) !== Object.prototype &&
       Object.getPrototypeOf(currentContentByPath) !== null)) {
    throw invalid('Current content map must be a plain data record.');
  }

  const output: Record<string, string> = Object.create(null);
  const previews: EditFilePreview[] = [];
  let totalBeforeBytes = 0;
  let totalAfterBytes = 0;

  for (const file of plan.files) {
    const entry = Object.getOwnPropertyDescriptor(currentContentByPath, file.path);
    if (!entry || !entry.enumerable || !('value' in entry) || typeof entry.value !== 'string') {
      throw new OperatorError('EDIT_PLAN_TARGET_MISSING', `Inert current content is missing for ${file.path}.`);
    }
    const current = entry.value;
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
  const raw = inertRecord(input, ['schemaVersion', 'id', 'files', 'verification'],
    ['schemaVersion', 'id', 'files', 'verification'], 'Edit plan');
  if (raw.schemaVersion !== 1 || typeof raw.id !== 'string') {
    throw invalid('Edit plan shape is invalid.');
  }
  const normalized = createMultiFileEditPlan({
    files: raw.files as MultiFileEditEntry[],
    verification: raw.verification as EditVerificationContract
  });
  if (normalized.id !== raw.id) {
    throw invalid('Edit plan id does not match its immutable content.');
  }
  return normalized;
}

function normalizeEdits(input: unknown, target: string): TextEditOperation[] {
  const sourceEdits = inertArray(input, 1, MAX_EDITS_PER_FILE, `Edits for ${target}`);
  let replacementBytes = 0;
  const edits = sourceEdits.map((item, index) => {
    const raw = inertRecord(item, ['start', 'end', 'replacement'],
      ['start', 'end', 'replacement'], `Edit ${index} for ${target}`);
    const start = integer(raw.start, 0, Number.MAX_SAFE_INTEGER, 'start');
    const end = integer(raw.end, start, Number.MAX_SAFE_INTEGER, 'end');
    // An edit replacement is source bytes, not a coercion surface. Arrays
    // and objects (including attacker-owned toString hooks) must be refused.
    if (typeof raw.replacement !== 'string') throw invalid('Edit replacement must be literal text.');
    const replacement = raw.replacement;
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
  return [...new Set(inertArray(input, 0, MAX_VERIFICATION_ITEMS, label).map(normalizeRelativePath))].sort();
}

function uniqueBoundedIds(input: unknown, label: string): string[] {
  const values = inertArray(input, 0, MAX_VERIFICATION_ITEMS, label).map((item) => {
    if (typeof item !== 'string') throw invalid(`${label} contains an invalid id.`);
    const value = item;
    if (!/^[A-Za-z0-9._:@/+\-=]{1,256}$/.test(value)) throw invalid(`${label} contains an invalid id.`);
    return value;
  });
  return [...new Set(values)].sort();
}

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(input: unknown, label: string): string {
  if (typeof input !== 'string') throw invalid(`${label} must be SHA-256.`);
  const value = input.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalid(`${label} must be SHA-256.`);
  return value;
}

function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== 'number') throw invalid(`${label} is invalid.`);
  const value = input;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is invalid.`);
  return value;
}

function invalid(message: string): OperatorError {
  return new OperatorError('MULTI_FILE_EDIT_PLAN_INVALID', message);
}
