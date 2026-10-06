import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';
import type {
  CodeIndexFile,
  CodeLanguage,
  CodeSymbol,
  CodeSymbolKind,
  WorkspaceCodeIndexSnapshot
} from './workspace-code-index.ts';

export interface SemanticSyntaxNode {
  id: string;
  path: string;
  language: CodeLanguage;
  kind: CodeSymbolKind;
  name: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  parentId?: string;
}

export interface SemanticCallEdge {
  fromNodeId?: string;
  path: string;
  line: number;
  callee: string;
  resolvedNodeId?: string;
  ambiguousCandidateIds: string[];
}

export interface WorkspaceSemanticSnapshot {
  schemaVersion: 1;
  id: string;
  codeIndexId: string;
  rootDigest: string;
  nodes: SemanticSyntaxNode[];
  calls: SemanticCallEdge[];
  observedAt: string;
}

export interface SyntaxSearchOptions {
  path?: string;
  kind?: CodeSymbolKind;
  name?: string;
  nameMode?: 'exact' | 'prefix' | 'contains';
  limit?: number;
}

export interface SemanticSymbolImpact {
  changedNodeIds: string[];
  impactedNodeIds: string[];
  impactedPaths: string[];
  suggestedTestPaths: string[];
}

export interface SemanticConflictAnalysis {
  status:
    | 'UNCHANGED'
    | 'ALREADY_APPLIED'
    | 'CURRENT_ONLY'
    | 'MERGEABLE_DISJOINT_SYMBOLS'
    | 'CONFLICTING_SYMBOLS'
    | 'AMBIGUOUS';
  currentChangedSymbols: string[];
  plannedChangedSymbols: string[];
  overlappingSymbols: string[];
  unscopedCurrentChange: boolean;
  unscopedPlannedChange: boolean;
}

const MAX_FILES = 50_000;
const MAX_NODES = 500_000;
const MAX_CALLS = 1_000_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_KEYWORDS = new Set([
  'if','for','while','switch','catch','function','return','typeof','delete',
  'new','super','this','class','interface','enum','with','synchronized'
]);

export class WorkspaceSemanticIntelligence {
  #rootInput: string;
  #root = '';
  #rootDigest = '';

  constructor(root: string) {
    this.#rootInput = path.resolve(root);
  }

  async build(indexInput: WorkspaceCodeIndexSnapshot): Promise<WorkspaceSemanticSnapshot> {
    await this.#init();
    const index = this.#validateIndex(indexInput);
    const nodes: SemanticSyntaxNode[] = [];
    const textByPath = new Map<string, string>();

    for (const file of index.files) {
      const text = await this.#readExact(file);
      textByPath.set(file.path, text);
      const fileNodes = buildDeclarationNodes(file, text);
      nodes.push(...fileNodes);
      if (nodes.length > MAX_NODES) throw invalid('Semantic syntax node budget exceeded.');
    }

    const nodeByName = new Map<string, SemanticSyntaxNode[]>();
    for (const node of nodes) {
      const bucket = nodeByName.get(node.name) ?? [];
      bucket.push(node);
      nodeByName.set(node.name, bucket);
    }

    const calls: SemanticCallEdge[] = [];
    const nodesByPath = groupNodesByPath(nodes);
    for (const file of index.files) {
      const text = textByPath.get(file.path)!;
      const lines = text.split(/\r?\n/);
      const fileNodes = nodesByPath.get(file.path) ?? [];
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = stripCommentsAndStrings(lines[lineIndex]!);
        CALL.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CALL.exec(line))) {
          const callee = match[1]!;
          if (CALL_KEYWORDS.has(callee)) continue;
          if (isDeclarationCallToken(file, lineIndex + 1, line, match.index, callee)) continue;
          const from = innermostNodeAtLine(fileNodes, lineIndex + 1);
          const candidates = resolveCallCandidates(callee, file.path, nodeByName);
          calls.push({
            ...(from ? { fromNodeId: from.id } : {}),
            path: file.path,
            line: lineIndex + 1,
            callee,
            ...(candidates.length === 1 ? { resolvedNodeId: candidates[0]!.id } : {}),
            ambiguousCandidateIds: candidates.length > 1 ? candidates.map((item) => item.id).sort() : []
          });
          if (calls.length > MAX_CALLS) throw invalid('Semantic call-edge budget exceeded.');
        }
      }
    }

    nodes.sort(compareNodes);
    calls.sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.callee.localeCompare(b.callee) ||
      String(a.fromNodeId ?? '').localeCompare(String(b.fromNodeId ?? ''))
    );
    const identity = {
      schemaVersion: 1 as const,
      codeIndexId: index.id,
      rootDigest: index.rootDigest,
      nodes,
      calls
    };
    return {
      ...identity,
      id: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
      observedAt: new Date().toISOString()
    };
  }

  searchSyntax(
    snapshotInput: WorkspaceSemanticSnapshot,
    options: SyntaxSearchOptions = {}
  ): SemanticSyntaxNode[] {
    const snapshot = validateSemanticSnapshot(snapshotInput);
    const limit = boundedInteger(options.limit ?? 100, 1, 5000, 'limit');
    const pathFilter = options.path === undefined ? undefined : normalizeRelativePath(options.path);
    const name = options.name?.toLocaleLowerCase();
    const mode = options.nameMode ?? 'contains';
    const hits: SemanticSyntaxNode[] = [];
    for (const node of snapshot.nodes) {
      if (pathFilter && node.path !== pathFilter) continue;
      if (options.kind && node.kind !== options.kind) continue;
      if (name) {
        const candidate = node.name.toLocaleLowerCase();
        const matches = mode === 'exact'
          ? candidate === name
          : mode === 'prefix'
            ? candidate.startsWith(name)
            : candidate.includes(name);
        if (!matches) continue;
      }
      hits.push(structuredClone(node));
      if (hits.length >= limit) break;
    }
    return hits;
  }

  callers(
    snapshotInput: WorkspaceSemanticSnapshot,
    nodeId: string
  ): SemanticCallEdge[] {
    const snapshot = validateSemanticSnapshot(snapshotInput);
    if (!snapshot.nodes.some((node) => node.id === nodeId)) throw invalid('Unknown semantic node id.');
    return snapshot.calls
      .filter((edge) => edge.resolvedNodeId === nodeId)
      .map((edge) => structuredClone(edge));
  }

  callees(
    snapshotInput: WorkspaceSemanticSnapshot,
    nodeId: string
  ): SemanticCallEdge[] {
    const snapshot = validateSemanticSnapshot(snapshotInput);
    if (!snapshot.nodes.some((node) => node.id === nodeId)) throw invalid('Unknown semantic node id.');
    return snapshot.calls
      .filter((edge) => edge.fromNodeId === nodeId)
      .map((edge) => structuredClone(edge));
  }

  impactForSymbols(
    snapshotInput: WorkspaceSemanticSnapshot,
    indexInput: WorkspaceCodeIndexSnapshot,
    changedNodeIdsInput: string[]
  ): SemanticSymbolImpact {
    const snapshot = validateSemanticSnapshot(snapshotInput);
    const index = this.#validateIndex(indexInput);
    if (snapshot.codeIndexId !== index.id) {
      throw invalid('Semantic snapshot and code index do not describe the same workspace observation.');
    }
    if (!Array.isArray(changedNodeIdsInput) || changedNodeIdsInput.length < 1 || changedNodeIdsInput.length > 10_000) {
      throw invalid('changedNodeIds is invalid.');
    }
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const changedNodeIds = [...new Set(changedNodeIdsInput)].sort();
    for (const id of changedNodeIds) {
      if (!byId.has(id)) throw invalid('changedNodeIds contains an unknown semantic node.');
    }

    const impactedNodes = new Set(changedNodeIds);
    const queue = [...changedNodeIds];
    const reverseCalls = new Map<string, Set<string>>();
    for (const edge of snapshot.calls) {
      if (!edge.resolvedNodeId || !edge.fromNodeId) continue;
      const bucket = reverseCalls.get(edge.resolvedNodeId) ?? new Set<string>();
      bucket.add(edge.fromNodeId);
      reverseCalls.set(edge.resolvedNodeId, bucket);
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const caller of reverseCalls.get(current) ?? []) {
        if (impactedNodes.has(caller)) continue;
        impactedNodes.add(caller);
        queue.push(caller);
      }
    }

    const impactedPathsSet = new Set(
      [...impactedNodes].map((id) => byId.get(id)!.path)
    );
    const reverseImports = new Map<string, Set<string>>();
    for (const file of index.files) {
      for (const dependency of file.imports) {
        if (!dependency.targetPath) continue;
        const bucket = reverseImports.get(dependency.targetPath) ?? new Set<string>();
        bucket.add(file.path);
        reverseImports.set(dependency.targetPath, bucket);
      }
    }
    const pathQueue = [...impactedPathsSet];
    while (pathQueue.length > 0) {
      const current = pathQueue.shift()!;
      for (const dependent of reverseImports.get(current) ?? []) {
        if (impactedPathsSet.has(dependent)) continue;
        impactedPathsSet.add(dependent);
        pathQueue.push(dependent);
      }
    }

    const impactedPaths = [...impactedPathsSet].sort();
    return {
      changedNodeIds,
      impactedNodeIds: [...impactedNodes].sort(),
      impactedPaths,
      suggestedTestPaths: impactedPaths.filter(isLikelyTestPath)
    };
  }

  #validateIndex(input: WorkspaceCodeIndexSnapshot): WorkspaceCodeIndexSnapshot {
    if (!input || input.schemaVersion !== 1 || !Array.isArray(input.files) || input.files.length > MAX_FILES) {
      throw invalid('Workspace code index snapshot is invalid.');
    }
    if (input.rootDigest !== this.#rootDigest) throw invalid('Workspace code index belongs to a different root.');
    const identity = {
      schemaVersion: 1 as const,
      rootDigest: input.rootDigest,
      files: input.files,
      skipped: input.skipped
    };
    if (input.id !== sha256(Buffer.from(canonicalJson(identity), 'utf8'))) {
      throw invalid('Workspace code index digest does not match its content.');
    }
    return structuredClone(input);
  }

  async #readExact(file: CodeIndexFile): Promise<string> {
    const absolute = path.join(this.#root, ...normalizeRelativePath(file.path).split('/'));
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) {
      throw new OperatorError(
        'WORKSPACE_SEMANTIC_STALE',
        'Semantic analysis target has unsafe or changed topology.',
        { details: { path: file.path } }
      );
    }
    const real = await fs.realpath(absolute);
    if (!inside(real, this.#root)) throw invalid('Semantic analysis target resolves outside workspace root.');
    const bytes = await fs.readFile(real);
    if (sha256(bytes) !== file.digest) {
      throw new OperatorError(
        'WORKSPACE_SEMANTIC_STALE',
        'Semantic analysis target changed after the code index snapshot.',
        { details: { path: file.path } }
      );
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw invalid('Semantic analysis target must be valid UTF-8.');
    return text;
  }

  async #init(): Promise<void> {
    if (this.#root) return;
    const stat = await fs.lstat(this.#rootInput);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid('Semantic workspace root must be a real directory.');
    this.#root = await fs.realpath(this.#rootInput);
    this.#rootDigest = sha256(Buffer.from(this.#root, 'utf8'));
  }
}

export function analyzeSemanticThreeWayConflict(input: {
  language: CodeLanguage;
  base: string;
  current: string;
  planned: string;
}): SemanticConflictAnalysis {
  const base = boundedSource(input.base, 'base');
  const current = boundedSource(input.current, 'current');
  const planned = boundedSource(input.planned, 'planned');
  if (current === base && planned === base) return emptyConflict('UNCHANGED');
  if (current === planned) return emptyConflict('ALREADY_APPLIED');
  if (planned === base) {
    return {
      status: 'CURRENT_ONLY',
      currentChangedSymbols: changedDeclarationNames(input.language, base, current).symbols,
      plannedChangedSymbols: [],
      overlappingSymbols: [],
      unscopedCurrentChange: changedDeclarationNames(input.language, base, current).unscoped,
      unscopedPlannedChange: false
    };
  }

  const currentChanges = changedDeclarationNames(input.language, base, current);
  const plannedChanges = changedDeclarationNames(input.language, base, planned);
  const overlap = currentChanges.symbols.filter((name) => plannedChanges.symbols.includes(name)).sort();
  if (overlap.length > 0) {
    return {
      status: 'CONFLICTING_SYMBOLS',
      currentChangedSymbols: currentChanges.symbols,
      plannedChangedSymbols: plannedChanges.symbols,
      overlappingSymbols: overlap,
      unscopedCurrentChange: currentChanges.unscoped,
      unscopedPlannedChange: plannedChanges.unscoped
    };
  }
  if (!currentChanges.unscoped && !plannedChanges.unscoped) {
    return {
      status: 'MERGEABLE_DISJOINT_SYMBOLS',
      currentChangedSymbols: currentChanges.symbols,
      plannedChangedSymbols: plannedChanges.symbols,
      overlappingSymbols: [],
      unscopedCurrentChange: false,
      unscopedPlannedChange: false
    };
  }
  return {
    status: 'AMBIGUOUS',
    currentChangedSymbols: currentChanges.symbols,
    plannedChangedSymbols: plannedChanges.symbols,
    overlappingSymbols: [],
    unscopedCurrentChange: currentChanges.unscoped,
    unscopedPlannedChange: plannedChanges.unscoped
  };
}

function buildDeclarationNodes(file: CodeIndexFile, text: string): SemanticSyntaxNode[] {
  const lines = text.split(/\r?\n/);
  const raw = file.symbols.map((symbol) => ({
    symbol,
    startLine: symbol.line,
    endLine: findDeclarationEnd(lines, symbol, file.language)
  }));
  const nodes: SemanticSyntaxNode[] = raw.map(({ symbol, startLine, endLine }) => ({
    id: sha256(Buffer.from(canonicalJson({
      path: file.path,
      kind: symbol.kind,
      name: symbol.name,
      startLine,
      endLine
    }), 'utf8')),
    path: file.path,
    language: file.language,
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported,
    startLine,
    endLine
  }));
  for (const node of nodes) {
    const parents = nodes
      .filter((candidate) =>
        candidate.id !== node.id &&
        candidate.startLine <= node.startLine &&
        candidate.endLine >= node.endLine
      )
      .sort((a, b) =>
        (a.endLine - a.startLine) - (b.endLine - b.startLine) ||
        b.startLine - a.startLine
      );
    if (parents[0]) node.parentId = parents[0].id;
  }
  return nodes;
}

function findDeclarationEnd(
  lines: string[],
  symbol: CodeSymbol,
  language: CodeLanguage
): number {
  const start = Math.max(0, symbol.line - 1);
  if (language === 'python') return pythonDeclarationEnd(lines, start);
  return braceDeclarationEnd(lines, start);
}

function pythonDeclarationEnd(lines: string[], start: number): number {
  const first = lines[start] ?? '';
  const indent = leadingWhitespace(first);
  let end = start + 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) {
      end = index + 1;
      continue;
    }
    if (leadingWhitespace(line) <= indent && !/^\s*(?:#|@)/.test(line)) break;
    end = index + 1;
  }
  return end;
}

function braceDeclarationEnd(lines: string[], start: number): number {
  let depth = 0;
  let sawBrace = false;
  let lexical: LexicalState = 'code';
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    for (let offset = 0; offset < line.length; offset += 1) {
      const ch = line[offset]!;
      const next = line[offset + 1];
      if (lexical === 'line-comment') break;
      if (lexical === 'block-comment') {
        if (ch === '*' && next === '/') { lexical = 'code'; offset += 1; }
        continue;
      }
      if (lexical === 'single') {
        if (ch === '\\') { offset += 1; continue; }
        if (ch === "'") lexical = 'code';
        continue;
      }
      if (lexical === 'double') {
        if (ch === '\\') { offset += 1; continue; }
        if (ch === '"') lexical = 'code';
        continue;
      }
      if (lexical === 'template') {
        if (ch === '\\') { offset += 1; continue; }
        if (ch === '`') lexical = 'code';
        continue;
      }
      if (ch === '/' && next === '/') { lexical = 'line-comment'; break; }
      if (ch === '/' && next === '*') { lexical = 'block-comment'; offset += 1; continue; }
      if (ch === "'") { lexical = 'single'; continue; }
      if (ch === '"') { lexical = 'double'; continue; }
      if (ch === '`') { lexical = 'template'; continue; }
      if (ch === '{') { sawBrace = true; depth += 1; }
      if (ch === '}') {
        if (sawBrace) depth -= 1;
        if (sawBrace && depth === 0) return index + 1;
      }
      if (!sawBrace && ch === ';') return index + 1;
    }
    if ((lexical as LexicalState) === 'line-comment') lexical = 'code';
    if (!sawBrace && index > start && !line.trim().endsWith(',')) return index + 1;
  }
  return Math.max(start + 1, lines.length);
}

type LexicalState = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';

function stripCommentsAndStrings(line: string): string {
  let out = '';
  let state: 'code' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') break;
      if (ch === "'") { state = 'single'; out += ' '; continue; }
      if (ch === '"') { state = 'double'; out += ' '; continue; }
      if (ch === '`') { state = 'template'; out += ' '; continue; }
      out += ch;
      continue;
    }
    if (ch === '\\') { out += '  '; i += 1; continue; }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    out += ' ';
  }
  return out;
}

function isDeclarationCallToken(
  file: CodeIndexFile,
  lineNumber: number,
  line: string,
  callOffset: number,
  callee: string
): boolean {
  const declarations = file.symbols.filter((symbol) =>
    symbol.line === lineNumber &&
    (symbol.kind === 'function' || symbol.kind === 'method') &&
    symbol.name === callee
  );
  for (const declaration of declarations) {
    const namePattern = new RegExp('\\b' + declaration.name + '\\s*\\(', 'g');
    const token = namePattern.exec(line);
    if (token?.index === callOffset) return true;
  }
  return false;
}

function resolveCallCandidates(
  callee: string,
  callerPath: string,
  byName: Map<string, SemanticSyntaxNode[]>
): SemanticSyntaxNode[] {
  const candidates = byName.get(callee) ?? [];
  const sameFile = candidates.filter((item) => item.path === callerPath);
  if (sameFile.length === 1) return sameFile;
  if (sameFile.length > 1) return sameFile;
  return candidates;
}

function innermostNodeAtLine(nodes: SemanticSyntaxNode[], line: number): SemanticSyntaxNode | undefined {
  return nodes
    .filter((node) => node.startLine <= line && node.endLine >= line)
    .sort((a, b) =>
      (a.endLine - a.startLine) - (b.endLine - b.startLine) ||
      b.startLine - a.startLine
    )[0];
}

function groupNodesByPath(nodes: SemanticSyntaxNode[]): Map<string, SemanticSyntaxNode[]> {
  const map = new Map<string, SemanticSyntaxNode[]>();
  for (const node of nodes) map.set(node.path, [...(map.get(node.path) ?? []), node]);
  for (const items of map.values()) items.sort(compareNodes);
  return map;
}

function compareNodes(a: SemanticSyntaxNode, b: SemanticSyntaxNode): number {
  return a.path.localeCompare(b.path) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine ||
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name);
}

function validateSemanticSnapshot(input: WorkspaceSemanticSnapshot): WorkspaceSemanticSnapshot {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.nodes) || !Array.isArray(input.calls)) {
    throw invalid('Semantic snapshot is invalid.');
  }
  const identity = {
    schemaVersion: 1 as const,
    codeIndexId: input.codeIndexId,
    rootDigest: input.rootDigest,
    nodes: input.nodes,
    calls: input.calls
  };
  if (input.id !== sha256(Buffer.from(canonicalJson(identity), 'utf8'))) {
    throw invalid('Semantic snapshot id does not match its immutable content.');
  }
  return structuredClone(input);
}

function changedDeclarationNames(
  language: CodeLanguage,
  base: string,
  variant: string
): { symbols: string[]; unscoped: boolean } {
  if (base === variant) return { symbols: [], unscoped: false };
  const baseMap = declarationContentMap(language, base);
  const variantMap = declarationContentMap(language, variant);
  const names = new Set([...baseMap.keys(), ...variantMap.keys()]);
  const changed: string[] = [];
  for (const name of names) {
    if (baseMap.get(name) !== variantMap.get(name)) changed.push(name);
  }
  changed.sort();
  const baseOutside = outsideDeclarationDigest(language, base);
  const variantOutside = outsideDeclarationDigest(language, variant);
  return { symbols: changed, unscoped: baseOutside !== variantOutside };
}

function declarationContentMap(language: CodeLanguage, text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const symbols = discoverDeclarations(lines, language);
  const result = new Map<string, string>();
  for (const symbol of symbols) {
    const end = findDeclarationEnd(lines, symbol, language);
    const body = lines.slice(symbol.line - 1, end).join('\n');
    result.set(symbol.name, sha256(Buffer.from(body, 'utf8')));
  }
  return result;
}

function outsideDeclarationDigest(language: CodeLanguage, text: string): string {
  const lines = text.split(/\r?\n/);
  const symbols = discoverDeclarations(lines, language);
  const covered = new Set<number>();
  for (const symbol of symbols) {
    const end = findDeclarationEnd(lines, symbol, language);
    for (let line = symbol.line; line <= end; line += 1) covered.add(line);
  }
  const outside = lines
    .map((line, index) => covered.has(index + 1) ? '' : line)
    .join('\n');
  return sha256(Buffer.from(outside, 'utf8'));
}

function discoverDeclarations(lines: string[], language: CodeLanguage): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const add = (regex: RegExp, kind: CodeSymbolKind, exported = false) => {
      const match = line.match(regex);
      if (match?.[1]) symbols.push({ name: match[1], kind, line: i + 1, exported });
    };
    if (language === 'typescript' || language === 'javascript') {
      const exported = /^\s*export\b/.test(line);
      add(/^(?:\s*export\s+(?:default\s+)?)?\s*class\s+([A-Za-z_$][\w$]*)/, 'class', exported);
      add(/^(?:\s*export\s+)?\s*interface\s+([A-Za-z_$][\w$]*)/, 'interface', exported);
      add(/^(?:\s*export\s+)?\s*type\s+([A-Za-z_$][\w$]*)\b/, 'type', exported);
      add(/^(?:\s*export\s+)?\s*enum\s+([A-Za-z_$][\w$]*)\b/, 'enum', exported);
      add(/^(?:\s*export\s+(?:default\s+)?)?\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function', exported);
      add(/^(?:\s*export\s+)?\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function', exported);
    } else if (language === 'java') {
      add(/^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+)*class\s+([A-Za-z_$][\w$]*)/, 'class', /\bpublic\b/.test(line));
      add(/^\s*(?:public\s+|protected\s+|private\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', /\bpublic\b/.test(line));
      add(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+)*[\w<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\(/, 'method', /\bpublic\b/.test(line));
    } else {
      add(/^\s*class\s+([A-Za-z_]\w*)\b/, 'class');
      add(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 'function');
    }
  }
  const deduped = new Map<string, CodeSymbol>();
  for (const symbol of symbols) deduped.set(symbol.kind + ':' + symbol.name + ':' + String(symbol.line), symbol);
  return [...deduped.values()];
}

function emptyConflict(status: SemanticConflictAnalysis['status']): SemanticConflictAnalysis {
  return {
    status,
    currentChangedSymbols: [],
    plannedChangedSymbols: [],
    overlappingSymbols: [],
    unscopedCurrentChange: false,
    unscopedPlannedChange: false
  };
}

function leadingWhitespace(line: string): number {
  const match = line.match(/^[ \t]*/)?.[0] ?? '';
  let count = 0;
  for (const ch of match) count += ch === '\t' ? 4 : 1;
  return count;
}

function boundedSource(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.includes('\0') || Buffer.byteLength(input, 'utf8') > MAX_FILE_BYTES) {
    throw invalid(label + ' source is invalid.');
  }
  return input;
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) {
    throw invalid('Workspace relative path is invalid.');
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw invalid('Workspace relative path escapes root.');
  }
  return normalized;
}

function inside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalid(label + ' is invalid.');
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function invalid(message: string): OperatorError {
  return new OperatorError('WORKSPACE_SEMANTIC_INTELLIGENCE_INVALID', message);
}
