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
  else if (action.capability === 'terminal.execute') values.push(input.cwd, ...terminalAffectedPaths(action));
  else if (action.capability === 'terminal.session' && input.operation === 'start') values.push(input.cwd, ...terminalAffectedPaths(action));
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')))];
}

/** Host paths whose contents may change, distinct from authorization-only operands such as terminal cwd. */
function resourceEffectPathOperandsForAction(action: ActionRequest): string[] {
  if (action.capability === 'terminal.execute'
    || (action.capability === 'terminal.session' && action.input.operation === 'start')) {
    return terminalAffectedPaths(action);
  }
  return resourcePathOperandsForAction(action);
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
    const affected = terminalAffectedPaths(action);
    if (affected.length === 0) keys.add('filesystem:any');
    else for (const affectedPath of affected) add('file', affectedPath, keys);
  } else if (action.capability === 'terminal.session') {
    if (input.operation === 'start') {
      const affected = terminalAffectedPaths(action);
      if (affected.length === 0) keys.add('filesystem:any');
      else for (const affectedPath of affected) add('file', affectedPath, keys);
    }
    else if (typeof input.sessionId === 'string' && input.sessionId) keys.add(`process:session/${requiredSegment(input.sessionId, 'session')}`);
  } else if (action.capability === 'process.inspect' || action.capability === 'process.manage') {
    const pid = Number(input.pid);
    keys.add(Number.isSafeInteger(pid) && pid > 0 ? `process:windows/${pid}` : 'process:windows');
  } else if (action.capability.startsWith('browser.')) {
    keys.add(browserResourceKey(action));
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
  const paths = resourceEffectPathOperandsForAction(action);

  for (const candidate of paths) {
    const physical = await physicalPathIdentity(candidate);
    keys.add(physical.pathKey);
    if (physical.objectKey) keys.add(physical.objectKey);
  }

  if (action.capability.startsWith('postgres.')) {
    const rootPath = [...keys].find((key) => key.startsWith('fs-path:'));
    if (rootPath) keys.add(`database:${rootPath.slice('fs-path:'.length)}/profile:${escapeSegment(String(input.profileId ?? 'profiles').toLowerCase())}`);
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
  const normalizedLeft = normalizeLegacyResourceKey(left);
  const normalizedRight = normalizeLegacyResourceKey(right);
  if (normalizedLeft === normalizedRight) return true;
  if ((normalizedLeft === 'filesystem:any' && isFilesystemResource(normalizedRight))
    || (normalizedRight === 'filesystem:any' && isFilesystemResource(normalizedLeft))) return true;
  const hierarchicalPrefixes = ['fs-path:', 'browser:', 'database:', 'process:', 'desktop:'];
  for (const prefix of hierarchicalPrefixes) {
    if (!normalizedLeft.startsWith(prefix) || !normalizedRight.startsWith(prefix)) continue;
    const a = normalizedLeft.slice(prefix.length);
    const b = normalizedRight.slice(prefix.length);
    return isHierarchyPrefix(a, b) || isHierarchyPrefix(b, a);
  }
  return false;
}

/** Canonicalizes persisted resource keys across compatible identity schema upgrades. */
export function canonicalResourceKeys(keys: readonly string[]): string[] {
  const normalized = [...new Set(keys.map(normalizeLegacyResourceKey))];
  return normalized.includes('filesystem:any')
    ? ['filesystem:any', ...normalized.filter((key) => !isFilesystemResource(key))].sort()
    : normalized.sort();
}

function browserResourceKey(action: ActionRequest): string {
  const input = action.input;
  const instance = requiredSegment(input.sessionId, 'default');
  const targets = `browser:instance:${instance}/targets`;
  const requestedTarget = action.capability === 'browser.navigate' && input.newTab === true
    ? undefined
    : typeof input.targetId === 'string' && input.targetId.trim()
      ? requiredSegment(input.targetId, 'target')
      : undefined;
  if (!requestedTarget) return targets;
  const target = `${targets}/${requestedTarget}`;
  const frame = typeof input.frameId === 'string' && input.frameId.trim()
    ? requiredSegment(input.frameId, 'frame')
    : undefined;
  return frame ? `${target}/frames/${frame}` : target;
}

function normalizeLegacyResourceKey(key: string): string {
  if (key.startsWith('workspace:')) return 'filesystem:any';
  const legacy = /^browser:session:([^/]+)\/target:([^/]+)(?:\/frame:([^/]+))?$/.exec(key);
  if (!legacy) return key;
  const [, instance, target, frame] = legacy;
  const targets = `browser:instance:${instance}/targets`;
  if (target === 'global') return targets;
  const concrete = `${targets}/${target}`;
  return frame ? `${concrete}/frames/${frame}` : concrete;
}

function terminalAffectedPaths(action: ActionRequest): string[] {
  const raw = action.input.affectedResources;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 128) {
    throw new OperatorError('RESOURCE_DECLARATION_INVALID', 'affectedResources must be a bounded array of typed resource declarations.');
  }
  const paths = raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperatorError('RESOURCE_DECLARATION_INVALID', `affectedResources[${index}] must be a typed resource declaration.`);
    }
    const declaration = item as Record<string, unknown>;
    const fields = Object.keys(declaration).sort();
    if (fields.join('\0') !== 'kind\0path' || declaration.kind !== 'path'
      || typeof declaration.path !== 'string' || declaration.path.length < 1
      || declaration.path.length > 4096 || declaration.path.includes('\0')) {
      throw new OperatorError('RESOURCE_DECLARATION_INVALID', `affectedResources[${index}] must contain only kind=path and a bounded path.`);
    }
    if (!path.isAbsolute(declaration.path)) {
      throw new OperatorError('RESOURCE_DECLARATION_INVALID', `affectedResources[${index}].path must be an absolute host path.`);
    }
    return path.resolve(declaration.path);
  });
  return [...new Set(paths)];
}

function isFilesystemResource(key: string): boolean {
  return key === 'filesystem:any'
    || ['fs-path:', 'fs-object:', 'file:', 'repo:', 'workspace:'].some((prefix) => key.startsWith(prefix));
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
