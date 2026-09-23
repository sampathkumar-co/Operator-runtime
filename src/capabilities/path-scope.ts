import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from '../core/errors.ts';
import { normalizeScopedPathSyntax } from '../core/scoped-path-syntax.ts';
import { withWindowsPathLease } from '../core/windows-path-lease.ts';

function lexicalInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PathScope {
  readonly roots: string[];
  #windowsPathLeaseExecutable?: string;

  constructor(roots: string[], options: { windowsPathLeaseExecutable?: string } = {}) {
    if (roots.length === 0) throw new OperatorError('NO_ALLOWED_ROOTS', 'At least one allowed root is required.');
    this.roots = roots.map((root) => path.resolve(root));
    this.#windowsPathLeaseExecutable = options.windowsPathLeaseExecutable;
  }

  async resolveExisting(inputPath: string): Promise<string> {
    const absolute = this.#absolute(inputPath);
    const real = await fs.realpath(absolute);
    const realRoots = await Promise.all(this.roots.map(async (root) => {
      try { return await fs.realpath(root); } catch { return root; }
    }));
    if (!realRoots.some((root) => lexicalInside(real, root))) {
      throw new OperatorError('PATH_OUTSIDE_SCOPE', 'Resolved path escapes the authorized roots.', { details: { inputPath, real } });
    }
    return real;
  }

  async resolveForWrite(inputPath: string): Promise<string> {
    const absolute = this.#absolute(inputPath);
    const parent = await fs.realpath(path.dirname(absolute));
    const realRoots = await Promise.all(this.roots.map(async (root) => {
      try { return await fs.realpath(root); } catch { return root; }
    }));
    if (!realRoots.some((root) => lexicalInside(parent, root))) {
      throw new OperatorError('PATH_OUTSIDE_SCOPE', 'Write target escapes the authorized roots.', { details: { inputPath, parent } });
    }
    return path.join(parent, path.basename(absolute));
  }

  async withExisting<T>(inputPath: string, operation: (resolvedPath: string) => Promise<T>): Promise<T> {
    const absolute = this.#absolute(inputPath);
    const root = this.#lexicalRoot(absolute);
    return await withWindowsPathLease({
      root,
      target: absolute,
      mode: 'existing',
      executable: this.#windowsPathLeaseExecutable
    }, async () => await operation(await this.resolveExisting(absolute)));
  }

  async withForWrite<T>(inputPath: string, operation: (resolvedPath: string) => Promise<T>): Promise<T> {
    const absolute = this.#absolute(inputPath);
    const root = this.#lexicalRoot(absolute);
    return await withWindowsPathLease({
      root,
      target: absolute,
      mode: 'parent',
      executable: this.#windowsPathLeaseExecutable
    }, async () => await operation(await this.resolveForWrite(absolute)));
  }

  #absolute(inputPath: string): string {
    const syntax = normalizeScopedPathSyntax(inputPath);
    if (syntax.kind === 'native-absolute') return syntax.value;
    if (syntax.kind === 'foreign-windows-absolute') {
      throw new OperatorError('PATH_OUTSIDE_SCOPE', 'Foreign absolute paths are outside the authorized roots.');
    }
    if (this.roots.length !== 1) {
      throw new OperatorError('PATH_OUTSIDE_SCOPE', 'Relative paths require exactly one authorized root.');
    }
    return path.resolve(this.roots[0]!, syntax.value);
  }

  #lexicalRoot(absolute: string): string {
    const candidates = this.roots.filter((root) => lexicalInside(absolute, root));
    candidates.sort((a, b) => b.length - a.length);
    if (!candidates[0]) throw new OperatorError('PATH_OUTSIDE_SCOPE', 'Requested path escapes the authorized roots.');
    return candidates[0];
  }
}
