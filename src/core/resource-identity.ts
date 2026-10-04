import fs from 'node:fs/promises';
import path from 'node:path';
import { CAPABILITY_RISK_RULES } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
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

export const RESOURCE_EXTRACTOR_CAPABILITIES = Object.freeze([
  'computer.inspect',
  'project.inspect', 'project.command.inspect', 'project.command.run', 'project.transaction.run',
  'file.read', 'file.list', 'file.write', 'file.create', 'file.replace', 'file.info', 'file.search', 'file.manage',
  'git.status', 'git.diff', 'git.rev-parse', 'git.checkpoint.inspect', 'git.checkpoint.create', 'git.checkpoint.restore', 'git.write',
  'docker.inspect', 'docker.manage', 'compute.run', 'postgres.inspect', 'postgres.select',
  'vscode.inspect', 'vscode.open', 'terminal.execute', 'terminal.session', 'process.inspect', 'process.manage',
  'browser.inspect', 'browser.verify', 'browser.navigate', 'browser.interact', 'browser.tab.focus', 'browser.tab.close',
  'app.inspect', 'app.operate', 'visual.capture', 'input.operate', 'perception.observe', 'perception.ground'
] as const);
const RESOURCE_EXTRACTOR_SET = new Set<string>(RESOURCE_EXTRACTOR_CAPABILITIES);

export function validateResourceExtractorCoverage(): void {
  const policyCapabilities = Object.keys(CAPABILITY_RISK_RULES).sort();
  const extractorCapabilities = [...RESOURCE_EXTRACTOR_CAPABILITIES].sort();
  if (policyCapabilities.join('\0') !== extractorCapabilities.join('\0')) {
    const missing = policyCapabilities.filter((capability) => !RESOURCE_EXTRACTOR_SET.has(capability));
    const extra = extractorCapabilities.filter((capability) => !(capability in CAPABILITY_RISK_RULES));
    throw new Error(`Canonical resource extractor coverage mismatch; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`);
  }
}
validateResourceExtractorCoverage();

function requiredSegment(value: unknown, fallback: string): string {
  const raw = String(value ?? fallback).trim().toLowerCase();
  return escapeSegment(raw || fallback);
}

/** Every host path operand that participates in capability authorization. */
export function resourcePathOperandsForAction(action: ActionRequest): string[] {
  const input = action.input;
  const values: unknown[] = [];
  if (action.capability === 'file.manage') values.push(input.path, input.source, input.destination);
  else if (action.capability.startsWith('file.')) values.push(input.path);
  else if (action.capability.startsWith('git.')) values.push(input.cwd);
  else if (action.capability.startsWith('project.')) values.push(input.path ?? input.cwd);
  else if (action.capability.startsWith('docker.')) values.push(input.path);
  else if (action.capability.startsWith('postgres.')) values.push(input.path);
  else if (action.capability === 'vscode.open') values.push(input.path, input.leftPath, input.rightPath);
  else if (action.capability === 'terminal.execute') values.push(input.cwd);
  else if (action.capability === 'terminal.session' && input.operation === 'start') values.push(input.cwd);
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')))];
}

/** Stable resource identities shared by Task, Team and future workflow schedulers. */
export function resourceKeysForAction(action: ActionRequest): string[] {
  if (!RESOURCE_EXTRACTOR_SET.has(action.capability)) {
    throw new OperatorError('RESOURCE_EXTRACTOR_UNREGISTERED', `Capability ${action.capability} has no canonical resource extractor.`);
  }
  const input = action.input;
  const keys = new Set<string>();

  if (action.capability === 'computer.inspect') {
    keys.add('computer:local');
  } else if (action.capability.startsWith('file.')) {
    if (action.capability === 'file.manage') {
      add('file', input.path, keys); add('file', input.source, keys); add('file', input.destination, keys);
    } else add('file', input.path, keys);
  } else if (action.capability.startsWith('git.')) {
    add('repo', input.cwd, keys);
  } else if (action.capability.startsWith('project.')) {
    add('repo', input.path ?? input.cwd, keys);
  } else if (action.capability.startsWith('docker.')) {
    add('docker', input.path, keys);
  } else if (action.capability === 'compute.run') {
    keys.add('compute:sandbox');
  } else if (action.capability.startsWith('postgres.')) {
    const root = normalizedAbsolute(input.path);
    const profile = requiredSegment(input.profileId, 'profiles');
    keys.add(root ? `database:${root}/profile:${profile}` : `database:profile:${profile}`);
  } else if (action.capability === 'vscode.inspect') {
    keys.add('vscode:installation');
  } else if (action.capability === 'vscode.open') {
    add('file', input.path, keys); add('file', input.leftPath, keys); add('file', input.rightPath, keys);
    keys.add('desktop:windows/vscode');
  } else if (action.capability === 'terminal.execute') {
    add('workspace', input.cwd, keys);
  } else if (action.capability === 'terminal.session') {
    if (input.operation === 'start') add('workspace', input.cwd, keys);
    else if (typeof input.sessionId === 'string' && input.sessionId) keys.add(`process:session/${requiredSegment(input.sessionId, 'session')}`);
  } else if (action.capability === 'process.inspect' || action.capability === 'process.manage') {
    const pid = Number(input.pid);
    keys.add(Number.isSafeInteger(pid) && pid > 0 ? `process:windows/${pid}` : 'process:windows');
  } else if (action.capability.startsWith('browser.')) {
    const session = requiredSegment(input.sessionId, 'default');
    const target = requiredSegment(input.targetId, 'global');
    const frame = input.frameId === undefined ? '' : `/frame:${requiredSegment(input.frameId, 'global')}`;
    keys.add(`browser:session:${session}/target:${target}${frame}`);
  } else if (action.capability.startsWith('app.') || action.capability === 'visual.capture' || action.capability === 'input.operate') {
    keys.add('desktop:windows');
  } else if (action.capability === 'perception.observe' || action.capability === 'perception.ground') {
    keys.add('perception:graph');
  }

  if (keys.size === 0) {
    throw new OperatorError('RESOURCE_TARGET_REQUIRED', `Capability ${action.capability} did not resolve to a concrete resource identity.`);
  }
  return [...keys].sort();
}


export async function resolvePhysicalResourceKeysForAction(action: ActionRequest): Promise<string[]> {
  const keys = new Set<string>(resourceKeysForAction(action));
  const input = action.input;
  const paths = resourcePathOperandsForAction(action);

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
  const hierarchicalPrefixes = ['fs-path:', 'browser:', 'database:', 'process:', 'desktop:'];
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
