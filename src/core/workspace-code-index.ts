import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

export type CodeLanguage = 'typescript' | 'javascript' | 'java' | 'python';

export type CodeSymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'variable';

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  line: number;
  exported: boolean;
}

export interface CodeImport {
  specifier: string;
  targetPath?: string;
}

export interface CodeIndexFile {
  path: string;
  language: CodeLanguage;
  digest: string;
  bytes: number;
  lineCount: number;
  symbols: CodeSymbol[];
  imports: CodeImport[];
}

export interface WorkspaceCodeIndexSnapshot {
  schemaVersion: 1;
  id: string;
  rootDigest: string;
  observedAt: string;
  files: CodeIndexFile[];
  skipped: {
    symlinkCount: number;
    hardLinkCount: number;
    oversizedCount: number;
    binaryCount: number;
  };
}

export interface CodeSearchHit {
  path: string;
  line: number;
  column: number;
  excerpt: string;
}

export interface CodeSearchResult {
  hits: CodeSearchHit[];
  stalePaths: string[];
  truncated: boolean;
}

export interface SymbolSearchHit extends CodeSymbol {
  path: string;
}

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  suggestedTestPaths: string[];
}

const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_INDEX_BYTES = 256 * 1024 * 1024;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'target'
]);

const EXTENSIONS: Record<string, CodeLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.java': 'java',
  '.py': 'python'
};

export interface WorkspaceCodeIndexerOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  ignoredDirectories?: string[];
  clock?: () => Date;
}

export class WorkspaceCodeIndexer {
  #rootInput: string;
  #root = '';
  #rootDigest = '';
  #maxFiles: number;
  #maxFileBytes: number;
  #ignoredDirectories: Set<string>;
  #clock: () => Date;

  constructor(root: string, options: WorkspaceCodeIndexerOptions = {}) {
    this.#rootInput = path.resolve(root);
    this.#maxFiles = boundedInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 200_000, 'maxFiles');
    this.#maxFileBytes = boundedInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1024, 16 * 1024 * 1024, 'maxFileBytes');
    this.#ignoredDirectories = new Set([
      ...DEFAULT_IGNORED_DIRECTORIES,
      ...(options.ignoredDirectories ?? []).map((item) => boundedName(item, 'ignoredDirectories'))
    ]);
    this.#clock = options.clock ?? (() => new Date());
  }

  async build(): Promise<WorkspaceCodeIndexSnapshot> {
    await this.#initializeRoot();
    const files: CodeIndexFile[] = [];
    const skipped = { symlinkCount: 0, hardLinkCount: 0, oversizedCount: 0, binaryCount: 0 };
    let indexedBytes = 0;

    const walk = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (files.length >= this.#maxFiles) {
          throw invalid('Workspace code index exceeded maxFiles.');
        }
        if (entry.name.includes('\0')) throw invalid('Workspace entry contains NUL.');

        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          skipped.symlinkCount += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (!this.#ignoredDirectories.has(entry.name)) await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;

        const language = EXTENSIONS[path.extname(entry.name).toLowerCase()];
        if (!language) continue;

        const stat = await fs.lstat(absolute);
        if (!stat.isFile()) continue;
        if (stat.nlink !== 1) {
          skipped.hardLinkCount += 1;
          continue;
        }
        if (stat.size > this.#maxFileBytes) {
          skipped.oversizedCount += 1;
          continue;
        }
        if (indexedBytes + stat.size > MAX_TOTAL_INDEX_BYTES) {
          throw invalid('Workspace code index exceeded total byte budget.');
        }

        const real = await fs.realpath(absolute);
        if (!isWithin(real, this.#root)) {
          throw invalid('Workspace file resolves outside the indexed root.');
        }

        const bytes = await fs.readFile(real);
        if (bytes.includes(0)) {
          skipped.binaryCount += 1;
          continue;
        }
        const text = bytes.toString('utf8');
        indexedBytes += bytes.byteLength;
        const relativePath = toPosix(path.relative(this.#root, real));
        const parsed = parseSource(text, language);
        files.push({
          path: relativePath,
          language,
          digest: sha256(bytes),
          bytes: bytes.byteLength,
          lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
          symbols: parsed.symbols,
          imports: parsed.imports.map((specifier) => ({ specifier }))
        });
      }
    };

    await walk(this.#root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    resolveRelativeImports(files);

    const identity = {
      schemaVersion: 1 as const,
      rootDigest: this.#rootDigest,
      files,
      skipped
    };
    return {
      ...identity,
      id: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
      observedAt: canonicalIso(this.#clock().toISOString(), 'observedAt')
    };
  }

  async searchText(
    snapshotInput: WorkspaceCodeIndexSnapshot,
    queryInput: string,
    options: { caseSensitive?: boolean; limit?: number } = {}
  ): Promise<CodeSearchResult> {
    await this.#initializeRoot();
    const snapshot = this.#validateSnapshot(snapshotInput);
    const query = boundedText(queryInput, 512, 'query');
    const caseSensitive = options.caseSensitive === true;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const limit = boundedInteger(options.limit ?? 100, 1, 1000, 'limit');
    const hits: CodeSearchHit[] = [];
    const stalePaths: string[] = [];
    let truncated = false;

    for (const file of snapshot.files) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const current = await this.#readCurrent(file);
      if (!current) {
        stalePaths.push(file.path);
        continue;
      }
      const lines = current.text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = caseSensitive ? line : line.toLocaleLowerCase();
        let from = 0;
        while (from <= haystack.length) {
          const found = haystack.indexOf(needle, from);
          if (found < 0) break;
          hits.push({
            path: file.path,
            line: index + 1,
            column: found + 1,
            excerpt: boundedExcerpt(line, found, query.length)
          });
          if (hits.length >= limit) {
            truncated = index + 1 < lines.length || file !== snapshot.files.at(-1);
            break;
          }
          from = found + Math.max(needle.length, 1);
        }
        if (hits.length >= limit) break;
      }
    }

    return {
      hits,
      stalePaths: [...new Set(stalePaths)].sort(),
      truncated
    };
  }

  findSymbols(
    snapshotInput: WorkspaceCodeIndexSnapshot,
    queryInput: string,
    options: { mode?: 'exact' | 'prefix' | 'contains'; limit?: number } = {}
  ): SymbolSearchHit[] {
    const snapshot = this.#validateSnapshot(snapshotInput);
    const query = boundedText(queryInput, 256, 'symbol query').toLocaleLowerCase();
    const mode = options.mode ?? 'contains';
    const limit = boundedInteger(options.limit ?? 100, 1, 1000, 'limit');
    const hits: SymbolSearchHit[] = [];

    for (const file of snapshot.files) {
      for (const symbol of file.symbols) {
        const candidate = symbol.name.toLocaleLowerCase();
        const match = mode === 'exact'
          ? candidate === query
          : mode === 'prefix'
            ? candidate.startsWith(query)
            : candidate.includes(query);
        if (!match) continue;
        hits.push({ ...symbol, path: file.path });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  impact(snapshotInput: WorkspaceCodeIndexSnapshot, changedPathsInput: string[]): ImpactResult {
    const snapshot = this.#validateSnapshot(snapshotInput);
    if (!Array.isArray(changedPathsInput) || changedPathsInput.length < 1 || changedPathsInput.length > 10_000) {
      throw invalid('changedPaths is invalid.');
    }

    const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const changed = [...new Set(changedPathsInput.map((item) => normalizeRelativePath(item)))].sort();
    for (const item of changed) {
      if (!byPath.has(item)) throw invalid(`Changed path is not present in the snapshot: ${item}`);
    }

    const reverse = new Map<string, Set<string>>();
    for (const file of snapshot.files) {
      for (const dependency of file.imports) {
        if (!dependency.targetPath) continue;
        const bucket = reverse.get(dependency.targetPath) ?? new Set<string>();
        bucket.add(file.path);
        reverse.set(dependency.targetPath, bucket);
      }
    }

    const impacted = new Set(changed);
    const queue = [...changed];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of reverse.get(current) ?? []) {
        if (impacted.has(dependent)) continue;
        impacted.add(dependent);
        queue.push(dependent);
      }
    }

    const impactedPaths = [...impacted].sort();
    const suggestedTestPaths = impactedPaths.filter(isLikelyTestPath);
    return { changedPaths: changed, impactedPaths, suggestedTestPaths };
  }

  #validateSnapshot(input: WorkspaceCodeIndexSnapshot): WorkspaceCodeIndexSnapshot {
    if (!input || input.schemaVersion !== 1 || !Array.isArray(input.files)) {
      throw invalid('Workspace code index snapshot is invalid.');
    }
    if (input.rootDigest !== this.#rootDigest) {
      throw invalid('Workspace code index belongs to a different root.');
    }
    const identity = {
      schemaVersion: 1 as const,
      rootDigest: input.rootDigest,
      files: input.files,
      skipped: input.skipped
    };
    const expected = sha256(Buffer.from(canonicalJson(identity), 'utf8'));
    if (input.id !== expected) throw invalid('Workspace code index digest does not match its content.');
    return structuredClone(input);
  }

  async #initializeRoot(): Promise<void> {
    if (this.#root) return;
    const stat = await fs.lstat(this.#rootInput);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw invalid('Workspace code index root must be a real directory.');
    }
    this.#root = await fs.realpath(this.#rootInput);
    this.#rootDigest = sha256(Buffer.from(this.#root, 'utf8'));
  }

  async #readCurrent(file: CodeIndexFile): Promise<{ text: string } | undefined> {
    const absolute = path.join(this.#root, ...file.path.split('/'));
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > this.#maxFileBytes) return undefined;
      const real = await fs.realpath(absolute);
      if (!isWithin(real, this.#root)) return undefined;
      const bytes = await fs.readFile(real);
      if (bytes.includes(0) || sha256(bytes) !== file.digest) return undefined;
      return { text: bytes.toString('utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

function parseSource(text: string, language: CodeLanguage): { symbols: CodeSymbol[]; imports: string[] } {
  const lines = text.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const imports = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (language === 'typescript' || language === 'javascript') {
      collectTsJsImports(line, imports);
      const exported = /^\s*export\b/.test(line);
      pushMatch(symbols, line, /^(?:\s*export\s+(?:default\s+)?)?\s*class\s+([A-Za-z_$][\w$]*)/, 'class', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+)?\s*interface\s+([A-Za-z_$][\w$]*)/, 'interface', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+)?\s*type\s+([A-Za-z_$][\w$]*)\b/, 'type', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+)?\s*enum\s+([A-Za-z_$][\w$]*)\b/, 'enum', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+(?:default\s+)?)?\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+)?\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function', lineNumber, exported);
      pushMatch(symbols, line, /^(?:\s*export\s+)?\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, 'variable', lineNumber, exported);
    } else if (language === 'java') {
      const importMatch = line.match(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/);
      if (importMatch) imports.add(importMatch[1]!);
      pushMatch(symbols, line, /^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|sealed\s+|non-sealed\s+)*class\s+([A-Za-z_$][\w$]*)/, 'class', lineNumber, /\bpublic\b/.test(line));
      pushMatch(symbols, line, /^\s*(?:public\s+|protected\s+|private\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', lineNumber, /\bpublic\b/.test(line));
      pushMatch(symbols, line, /^\s*(?:public\s+|protected\s+|private\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum', lineNumber, /\bpublic\b/.test(line));
      pushMatch(symbols, line, /^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+|abstract\s+|native\s+)*[\w<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[^{]+)?\{?\s*$/, 'method', lineNumber, /\bpublic\b/.test(line));
    } else if (language === 'python') {
      const fromMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
      if (fromMatch) imports.add(fromMatch[1]!);
      const importMatch = line.match(/^\s*import\s+([\w.]+)/);
      if (importMatch) imports.add(importMatch[1]!);
      pushMatch(symbols, line, /^\s*class\s+([A-Za-z_]\w*)\b/, 'class', lineNumber, false);
      pushMatch(symbols, line, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 'function', lineNumber, false);
    }
  }

  return {
    symbols: dedupeSymbols(symbols),
    imports: [...imports].sort()
  };
}

function collectTsJsImports(line: string, imports: Set<string>): void {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) imports.add(match[1]!);
  }
}

function pushMatch(
  symbols: CodeSymbol[],
  line: string,
  pattern: RegExp,
  kind: CodeSymbolKind,
  lineNumber: number,
  exported: boolean
): void {
  const match = line.match(pattern);
  if (!match?.[1]) return;
  symbols.push({ name: match[1], kind, line: lineNumber, exported });
}

function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveRelativeImports(files: CodeIndexFile[]): void {
  const paths = new Set(files.map((file) => file.path));
  const supportedExtensions = Object.keys(EXTENSIONS);
  for (const file of files) {
    for (const dependency of file.imports) {
      if (!dependency.specifier.startsWith('.')) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), dependency.specifier));
      const candidates = [
        base,
        ...supportedExtensions.map((extension) => base + extension),
        ...supportedExtensions.map((extension) => path.posix.join(base, 'index' + extension))
      ];
      dependency.targetPath = candidates.find((candidate) => paths.has(candidate));
    }
  }
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) {
    throw invalid('Workspace relative path is invalid.');
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw invalid('Workspace relative path escapes the root.');
  }
  return normalized;
}

function isLikelyTestPath(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  return lower.includes('/test/') ||
    lower.includes('/tests/') ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(lower) ||
    lower.endsWith('test.java') ||
    lower.endsWith('_test.py') ||
    lower.startsWith('test_') ||
    lower.includes('/test_');
}

function boundedExcerpt(line: string, column: number, length: number): string {
  const start = Math.max(0, column - 80);
  const end = Math.min(line.length, column + Math.max(length, 1) + 120);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < line.length ? '…' : '';
  return prefix + line.slice(start, end) + suffix;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${label} is invalid.`);
  return value;
}

function boundedName(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input || input.length > 256 || /[\\/\0]/.test(input)) {
    throw invalid(`${label} contains an invalid directory name.`);
  }
  return input;
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input || Buffer.byteLength(input, 'utf8') > maxBytes || input.includes('\0')) {
    throw invalid(`${label} is invalid.`);
  }
  return input;
}

function canonicalIso(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalid(`${label} must be canonical ISO.`);
  }
  return value;
}

function invalid(message: string): OperatorError {
  return new OperatorError('WORKSPACE_CODE_INDEX_INVALID', message);
}
