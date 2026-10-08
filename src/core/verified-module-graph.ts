import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { OperatorError } from './errors.ts';

/**
 * A publisher-signed, content-addressed ESM dependency graph.
 * This is integrity enforcement, NOT a sandbox for publisher code.
 */
export interface VerifiedModuleGraph {
  entry: string;
  modules: Array<{ path: string; sha256: string }>;
}

const MAX_MODULES = 64;
const MAX_MODULE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SCHEME = 'operator-verified://';
const modules = new Map<string, { owner: string; bytes: Buffer }>();
let hooksInstalled = false;

function invalid(message: string): never {
  throw new OperatorError('CAPABILITY_MODULE_GRAPH_INVALID', message);
}

function modulePath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 ||
    value.includes('\\') || value.includes('%') || value.startsWith('/') ||
    !/^[a-zA-Z0-9_./-]+\.mjs$/.test(value)) {
    return invalid('Signed module paths must be bounded, relative POSIX .mjs paths.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return invalid('Signed module path contains empty, dot or parent segments.');
  }
  return value;
}

export function normalizeVerifiedModuleGraph(value: unknown): VerifiedModuleGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Signed module graph must be an object.');
  const raw = value as Record<string, unknown>;
  const entry = modulePath(raw.entry);
  if (entry.includes('/')) return invalid('Signed module entry must be at the package root.');
  if (!Array.isArray(raw.modules) || raw.modules.length < 2 || raw.modules.length > MAX_MODULES) {
    return invalid('Multi-file packages must declare 2-64 module files.');
  }
  const seen = new Set<string>();
  const list = raw.modules.map((rawModule) => {
    if (!rawModule || typeof rawModule !== 'object' || Array.isArray(rawModule)) {
      return invalid('Module graph entry must be an object.');
    }
    const item = rawModule as Record<string, unknown>;
    const relative = modulePath(item.path);
    const digest = item.sha256;
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return invalid('Each signed module must declare a lowercase SHA-256 digest.');
    }
    // Windows filesystems are typically case-insensitive. Never permit aliases
    // that could resolve to one executable file with competing signatures.
    const canonical = relative.toLowerCase();
    if (seen.has(canonical)) return invalid('Module graph contains duplicate or case-colliding module paths.');
    seen.add(canonical);
    return { path: relative, sha256: digest };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!seen.has(entry.toLowerCase()) || !list.some((file) => file.path === entry)) {
    return invalid('Signed entry module must be declared with exactly matching case.');
  }
  return { entry, modules: list };
}

export function verifiedModuleGraphDigest(graph: VerifiedModuleGraph): string {
  const normalized = normalizeVerifiedModuleGraph(graph);
  return crypto.createHash('sha256').update(canonicalJson({
    format: 'operator-signed-esm-graph/v1',
    entry: normalized.entry,
    modules: normalized.modules
  })).digest('hex');
}

/** Snapshot all files before evaluating even the entry module. */
export async function snapshotVerifiedModuleGraph(input: {
  entryPath: string;
  graph: VerifiedModuleGraph;
  readModuleBytes: (realPath: string) => Promise<Uint8Array>;
}): Promise<Map<string, Buffer>> {
  const graph = normalizeVerifiedModuleGraph(input.graph);
  if (path.basename(input.entryPath) !== graph.entry) {
    return invalid('Signed graph entry does not match the authorized entry path.');
  }
  const root = path.dirname(input.entryPath);
  const snapshots = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const module of graph.modules) {
    const requested = path.join(root, ...module.path.split('/'));
    const real = await fs.realpath(requested);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      return invalid('Signed dependency resolves outside its authorized package root.');
    }
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MODULE_BYTES) {
      return invalid('Signed module must be a nonempty regular file of at most 8 MiB.');
    }
    const bytes = Buffer.from(await input.readModuleBytes(real));
    totalBytes += bytes.length;
    if (bytes.length < 1 || bytes.length > MAX_MODULE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      return invalid('Signed dependency graph exceeds the module or aggregate byte bound.');
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== module.sha256) {
      throw new OperatorError('CAPABILITY_MODULE_DIGEST_MISMATCH',
        'Signed graph dependency bytes do not match the publisher-authorized digest.');
    }
    snapshots.set(module.path, bytes);
  }
  return snapshots;
}

function installHooks(): void {
  if (hooksInstalled) return;
  const registerHooks = (nodeModule as unknown as {
    registerHooks?: (hooks: {
      resolve: (specifier: string, context: { parentURL?: string }, nextResolve: (value: string, context: unknown) => unknown) => unknown;
      load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) => unknown;
    }) => unknown;
  }).registerHooks;
  if (typeof registerHooks !== 'function') {
    throw new OperatorError('CAPABILITY_MODULE_GRAPH_RUNTIME_UNSUPPORTED',
      'Signed multi-file modules require Node.js 22.15+ synchronous module hooks; the single-file signed loader remains supported.');
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (parent?.startsWith(SCHEME)) {
        if (!modules.has(parent)) return invalid('Signed module graph is no longer active.');
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          return invalid('Signed modules may import only declared local relative modules.');
        }
        const url = new URL(specifier, parent).href;
        const child = modules.get(url);
        if (!child || child.owner !== modules.get(parent)!.owner) {
          return invalid('Import is not present in the same signed module graph.');
        }
        return { url, shortCircuit: true };
      }
      if (specifier.startsWith(SCHEME)) {
        if (!modules.has(specifier)) return invalid('Unregistered signed module graph URL.');
        return { url: specifier, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(SCHEME)) {
        const signed = modules.get(url);
        if (!signed) return invalid('Signed graph is no longer active.');
        return { format: 'module', source: signed.bytes, shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  hooksInstalled = true;
}

/**
 * Register only already-verified bytes. Release tears down our registry so
 * late dynamic imports fail closed; runtime module caching cannot be undone.
 */
export function registerVerifiedModuleGraph(
  graph: VerifiedModuleGraph, snapshots: Map<string, Buffer>
): { entryUrl: string; release: () => void } {
  installHooks();
  const normalized = normalizeVerifiedModuleGraph(graph);
  const owner = crypto.randomUUID();
  const prefix = SCHEME + owner + '/';
  const keys: string[] = [];
  try {
    for (const item of normalized.modules) {
      const bytes = snapshots.get(item.path);
      if (!bytes) return invalid('Module graph snapshot is missing a signed dependency.');
      const url = new URL(item.path, prefix).href;
      if (modules.has(url)) return invalid('Signed module URL collision.');
      modules.set(url, { owner, bytes });
      keys.push(url);
    }
    return {
      entryUrl: new URL(normalized.entry, prefix).href,
      release: () => { for (const key of keys) modules.delete(key); }
    };
  } catch (error) {
    for (const key of keys) modules.delete(key);
    throw error;
  }
}
