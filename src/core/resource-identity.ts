import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionRequest } from './types.ts';

function normalizedAbsolute(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\0')) return undefined;
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function add(prefix: string, value: unknown, target: Set<string>): void {
  const resolved = normalizedAbsolute(value);
  if (resolved) target.add(`${prefix}:${resolved}`);
}

/** Stable resource identities shared by Task, Team and future workflow schedulers. */
export function resourceKeysForAction(action: ActionRequest): string[] {
  const input = action.input;
  const keys = new Set<string>();
  if (action.capability.startsWith('file.')) {
    if (action.capability === 'file.manage') {
      add('file', input.path, keys);
      add('file', input.source, keys);
      add('file', input.destination, keys);
    } else {
      add('file', input.path, keys);
    }
  } else if (action.capability === 'workspace.edit.transaction') {
    const root = input.workspaceRoot;
    add('workspace', root, keys);
    const files = (input.plan as { files?: Array<{ path?: unknown }> } | undefined)?.files;
    if (typeof root === 'string' && Array.isArray(files)) {
      for (const file of files.slice(0, 1000)) {
        if (typeof file?.path === 'string') add('file', path.join(root, ...file.path.split('/')), keys);
      }
    }
  } else if (action.capability.startsWith('git.')) {
    add('repo', input.cwd, keys);
  } else if (action.capability.startsWith('project.')) {
    add('repo', input.path ?? input.cwd, keys);
  } else if (action.capability.startsWith('docker.')) {
    add('docker', input.path, keys);
  } else if (action.capability.startsWith('postgres.')) {
    const root = normalizedAbsolute(input.path);
    if (root) keys.add(`database:${root}:${String(input.profileId ?? 'profiles').toLowerCase()}`);
  } else if (action.capability.startsWith('vscode.')) {
    add('file', input.path, keys);
    add('file', input.leftPath, keys);
    add('file', input.rightPath, keys);
  } else if (action.capability === 'terminal.execute') {
    add('workspace', input.cwd, keys);
  } else if (action.capability === 'terminal.session') {
    if (input.operation === 'start') add('workspace', input.cwd, keys);
    else if (typeof input.sessionId === 'string') keys.add(`process:${input.sessionId.toLowerCase()}`);
  } else if (action.capability === 'process.inspect' || action.capability === 'process.manage') {
    keys.add('process:windows');
  } else if (action.capability.startsWith('browser.')) {
    keys.add(`browser:${String(input.targetId ?? 'global').toLowerCase()}`);
  } else if (action.capability.startsWith('app.') || action.capability === 'visual.capture' || action.capability === 'input.operate') {
    keys.add('desktop:windows');
  } else {
    keys.add(`cap:${action.capability.toLowerCase()}`);
  }
  return [...keys].sort();
}


export async function resolvePhysicalResourceKeysForAction(action: ActionRequest): Promise<string[]> {
  const keys = new Set<string>(resourceKeysForAction(action));
  const input = action.input;
  const paths = new Set<string>();
  const addPath = (value: unknown) => {
    if (typeof value === 'string' && value && !value.includes('\0')) paths.add(value);
  };

  if (action.capability.startsWith('file.')) {
    addPath(input.path); addPath(input.source); addPath(input.destination);
  } else if (action.capability === 'workspace.edit.transaction') {
    const root = input.workspaceRoot;
    addPath(root);
    const files = (input.plan as { files?: Array<{ path?: unknown }> } | undefined)?.files;
    if (typeof root === 'string' && Array.isArray(files)) {
      for (const file of files.slice(0, 1000)) {
        if (typeof file?.path === 'string') addPath(path.join(root, ...file.path.split('/')));
      }
    }
  } else if (action.capability.startsWith('git.')) {
    addPath(input.cwd);
  } else if (action.capability.startsWith('project.')) {
    addPath(input.path ?? input.cwd);
  } else if (action.capability.startsWith('docker.')) {
    addPath(input.path);
  } else if (action.capability.startsWith('postgres.')) {
    addPath(input.path);
  } else if (action.capability.startsWith('vscode.')) {
    addPath(input.path); addPath(input.leftPath); addPath(input.rightPath);
  } else if (action.capability === 'terminal.execute' || (action.capability === 'terminal.session' && input.operation === 'start')) {
    addPath(input.cwd);
  }

  for (const candidate of paths) {
    const physical = await physicalPathIdentity(candidate);
    keys.add(physical.pathKey);
    if (physical.objectKey) keys.add(physical.objectKey);
  }

  if (action.capability.startsWith('postgres.')) {
    const rootPath = [...keys].find((key) => key.startsWith('fs-path:'));
    if (rootPath) keys.add(`database:${rootPath.slice('fs-path:'.length)}/profile:${escapeSegment(String(input.profileId ?? 'profiles').toLowerCase())}`);
  }

  if (action.capability.startsWith('browser.')) {
    const session = escapeSegment(String(input.sessionId ?? 'default').toLowerCase());
    const target = escapeSegment(String(input.targetId ?? 'global').toLowerCase());
    const frame = input.frameId === undefined ? undefined : escapeSegment(String(input.frameId).toLowerCase());
    keys.add(`browser:session:${session}/target:${target}${frame ? `/frame:${frame}` : ''}`);
  }

  if (action.capability === 'process.inspect' || action.capability === 'process.manage') {
    keys.add(`process:windows/${escapeSegment(String(input.pid ?? 'global'))}`);
  }

  if (action.capability.startsWith('app.') || action.capability === 'visual.capture' || action.capability === 'input.operate') {
    keys.add('desktop:windows');
  }
  return [...keys].sort();
}

export function resourceKeysConflict(left: string, right: string): boolean {
  if (left === right) return true;
  const hierarchicalPrefixes = ['fs-path:', 'browser:', 'database:', 'process:'];
  for (const prefix of hierarchicalPrefixes) {
    if (!left.startsWith(prefix) || !right.startsWith(prefix)) continue;
    const a = left.slice(prefix.length);
    const b = right.slice(prefix.length);
    return isHierarchyPrefix(a, b) || isHierarchyPrefix(b, a);
  }
  return false;
}

async function physicalPathIdentity(input: string): Promise<{ pathKey: string; objectKey?: string }> {
  const requested = path.resolve(input);
  let probe = requested;
  const missing: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(probe);
      const stat = await fs.stat(real);
      const suffix = missing.length === 0 ? '' : '/' + missing.reverse().map(escapeSegment).join('/');
      const canonical = normalizePhysicalPath(real) + suffix;
      return {
        pathKey: `fs-path:${canonical}`,
        ...(missing.length === 0 ? { objectKey: `fs-object:${String(stat.dev)}:${String(stat.ino)}` } : {})
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return { pathKey: `fs-path:${normalizePhysicalPath(requested)}` };
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function normalizePhysicalPath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function escapeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '%252F');
}

function isHierarchyPrefix(parent: string, child: string): boolean {
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}
