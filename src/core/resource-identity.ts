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
