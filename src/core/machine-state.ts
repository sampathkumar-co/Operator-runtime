import crypto from 'node:crypto';
import type { ActionRequest, ActionResult, Evidence } from './types.ts';
import type { TaskObservationDomain, TaskObservationSummaryV2 } from './task.ts';

const SAFE_STATE_KEYS = new Set([
  'sha256', 'size', 'bytes', 'count', 'clean', 'operation', 'verified',
  'exitCode', 'state', 'healthy', 'selected', 'expand_collapse_state', 'truncated',
  'events_truncated', 'waited_ms', 'observed_ms', 'max_nodes', 'max_depth',
  'afterCaptured', 'captureLeaseConsumed', 'changed', 'windowStable', 'afterSha256', 'dispatched'
]);
const AMBIGUOUS_ERROR = /AMBIGUOUS|MULTIPLE_MATCH|TARGET_NOT_UNIQUE/i;

export function normalizeMachineObservation(
  action: ActionRequest,
  result: ActionResult,
  channel: 'semantic' | 'visual' = 'semantic'
): TaskObservationSummaryV2 {
  const domain = observationDomain(result.capability, result.provider);
  const importantState = importantStateFromResult(result);
  const entityId = observationEntityId(action, result, domain);
  return {
    schemaVersion: 2,
    channel,
    domain,
    provider: bounded(result.provider, 256),
    capability: bounded(result.capability, 256),
    entityId,
    observedAt: new Date().toISOString(),
    stateVersion: sha256(canonicalJson({ domain, entityId, importantState })),
    importantState,
    ambiguous: AMBIGUOUS_ERROR.test(result.error?.code ?? ''),
    confidence: observationConfidence(result),
    evidenceRefs: result.evidence.slice(0, 100).map(evidenceRef)
  };
}

export function observationDomain(capability: string, provider: string): TaskObservationDomain {
  const lowerProvider = provider.toLowerCase();
  if (lowerProvider.includes('uia')) return 'uia';
  if (capability.startsWith('project.')) return 'project';
  if (capability.startsWith('file.')) return 'filesystem';
  if (capability.startsWith('git.')) return 'git';
  if (capability.startsWith('docker.')) return 'docker';
  if (capability.startsWith('postgres.')) return 'database';
  if (capability.startsWith('vscode.')) return 'ide';
  if (capability.startsWith('browser.')) return 'browser';
  if (capability.startsWith('terminal.') || capability.startsWith('process.')) return 'process';
  if (capability.startsWith('computer.')) return 'system';
  if (capability.startsWith('app.')) return 'application';
  return channelFromProvider(lowerProvider);
}

function channelFromProvider(provider: string): TaskObservationDomain {
  if (provider.includes('docker')) return 'docker';
  if (provider.includes('postgres')) return 'database';
  if (provider.includes('vscode')) return 'ide';
  return 'unknown';
}
function observationEntityId(action: ActionRequest, result: ActionResult, domain: TaskObservationDomain): string {
  const output = record(result.output);
  const target = action.target
    ?? text(output.targetId)
    ?? text(record(output.target).id)
    ?? text(action.input.path)
    ?? text(action.input.cwd)
    ?? text(action.input.targetId)
    ?? canonicalJson(action.input.selector ?? {});
  return `${domain}:${sha256(`${result.capability}\0${target || result.provider}`).slice(0, 32)}`;
}

function importantStateFromResult(result: ActionResult): Record<string, unknown> {
  const state: Record<string, unknown> = { ok: result.ok };
  if (result.error?.code) state.errorCode = bounded(result.error.code, 128);
  const output = record(result.output);
  for (const [key, value] of Object.entries(output)) {
    if (SAFE_STATE_KEYS.has(key) && isSafeScalar(value)) state[key] = value;
  }
  if (result.capability === 'git.status') {
    const entries = Array.isArray(output.entries) ? output.entries.map(record).slice(0, 500) : [];
    const pathHashes = entries.flatMap((entry) => {
      const rawPath = text(entry.path);
      if (!rawPath) return [];
      const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      return [sha256(normalized)];
    });
    if (pathHashes.length) state.gitPathHashes = [...new Set(pathHashes)].sort();
  }
  if (result.capability.startsWith('docker.')) {
    const scope = text(output.scope);
    if (scope === 'project' || scope === 'daemon') state.scope = scope;
    for (const key of ['fingerprint', 'beforeFingerprint', 'afterFingerprint']) {
      const value = text(output[key]);
      if (value && /^[0-9a-f]{64}$/i.test(value)) state[key] = value.toLowerCase();
    }
    const services = normalizeDockerServices(output.services ?? output.states);
    if (services.length) state.services = services;
  }
  if (result.capability.startsWith('browser.')) {
    const tabs: Array<Record<string, unknown>> = [];
    if (Array.isArray(output.tabs)) tabs.push(...output.tabs.map(record));
    const target = record(output.target);
    if (Object.keys(target).length > 0) tabs.push(target);
    const safeTabs = tabs.slice(0, 50).flatMap((tab) => {
      const id = text(tab.id);
      const type = text(tab.type);
      const url = text(tab.url);
      const destinationDigest = url ? browserDestinationDigest(url) : undefined;
      if (!id && !destinationDigest) return [];
      return [{
        ...(id ? { id: bounded(id, 256) } : {}),
        ...(type && /^[a-z][a-z0-9_-]{0,31}$/i.test(type) ? { type } : {}),
        ...(destinationDigest ? { destinationDigest } : {})
      }];
    });
    if (safeTabs.length) state.browserTargets = safeTabs;
    const targetId = text(output.targetId);
    const directUrl = text(output.url);
    if (targetId) state.targetId = bounded(targetId, 256);
    if (directUrl) state.destinationDigest = browserDestinationDigest(directUrl);
  }
  if (result.capability.startsWith('app.')) {
    const elements = Array.isArray(output.elements) ? output.elements.map(record).slice(0, 5) : [];
    const safeElements = elements.map((element) => {
      const item: Record<string, unknown> = {};
      for (const [source, destination] of [
        ['name', 'nameHash'], ['automationId', 'automationIdHash'], ['automation_id', 'automationIdHash'],
        ['className', 'classNameHash'], ['class_name', 'classNameHash'],
        ['controlType', 'controlTypeHash'], ['control_type', 'controlTypeHash']
      ] as const) {
        const value = text(element[source]);
        if (value && item[destination] === undefined) item[destination] = sha256(value);
      }
      const value = text(element.value);
      if (value !== undefined) item.valueHash = sha256(value);
      const processId = Number(element.processId ?? element.process_id);
      if (Number.isSafeInteger(processId) && processId > 0 && processId <= 0x7fffffff) item.processId = processId;
      for (const [source, destination] of [
        ['enabled', 'enabled'], ['isEnabled', 'enabled'], ['offscreen', 'offscreen'],
        ['isOffscreen', 'offscreen'], ['focused', 'focused'], ['hasKeyboardFocus', 'focused'],
        ['selected', 'selected'], ['isSelected', 'selected']
      ] as const) {
        const value = element[source];
        if (typeof value === 'boolean' && item[destination] === undefined) item[destination] = value;
      }
      const expandCollapseState = text(element.expandCollapseState ?? element.expand_collapse_state);
      if (expandCollapseState && /^[a-z_]{1,32}$/i.test(expandCollapseState)) item.expandCollapseState = expandCollapseState.toLowerCase();
      return item;
    }).filter((item) => Object.keys(item).length > 0);
    if (safeElements.length) state.uiaElements = safeElements;
  }
  if (result.capability === 'project.command.run' || result.capability === 'project.transaction.run') {
    const command = record(output.command);
    const validation = record(output.validation);
    const execution = record(output.execution);
    const commandKind = text(command.kind);
    if (commandKind && /^[a-z][a-z0-9_-]{0,63}$/i.test(commandKind)) state.commandKind = commandKind;
    if (typeof validation.passed === 'boolean') state.validationPassed = validation.passed;
    const exitCode = Number(execution.exitCode);
    if (Number.isSafeInteger(exitCode) && exitCode >= -1_000_000 && exitCode <= 1_000_000) state.exitCode = exitCode;
  }
  if (result.capability.startsWith('postgres.')) {
    const profileId = text(output.profileId);
    const schema = text(output.schema);
    const table = text(output.table);
    if (profileId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) state.profileId = profileId;
    if (schema && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(schema)) state.schema = schema;
    if (table && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(table)) state.table = table;
    for (const key of ['rowCount', 'limit', 'offset']) {
      const value = Number(output[key]);
      if (Number.isSafeInteger(value) && value >= 0 && value <= 10_000) state[key] = value;
    }
    if (Array.isArray(output.columns)) {
      const columns = output.columns.map(String).filter((column) => column === '*' || /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(column)).slice(0, 50);
      if (columns.length) state.columns = columns;
    }
    if (Array.isArray(output.profiles)) state.profileCount = Math.min(output.profiles.length, 1000);
    if (Array.isArray(output.rows) && output.operation === 'columns') state.columnCount = Math.min(output.rows.length, 500);
  }
  const postcondition = record(output.postcondition);
  const safePostcondition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(postcondition)) {
    if ((SAFE_STATE_KEYS.has(key) || key === 'focused' || key === 'foreground') && isSafeScalar(value)) safePostcondition[key] = value;
  }
  if (Object.keys(safePostcondition).length) state.postcondition = safePostcondition;
  return state;
}

function normalizeDockerServices(input: unknown): Array<{ service: string; containers: number; states: string[] }> {
  if (!Array.isArray(input)) return [];
  const output: Array<{ service: string; containers: number; states: string[] }> = [];
  for (const item of input.slice(0, 50)) {
    const raw = record(item);
    const service = text(raw.service);
    const containers = Number(raw.containers ?? 0);
    const states = Array.isArray(raw.states)
      ? [...new Set(raw.states.map(String).filter((state) => /^[a-z][a-z0-9_-]{0,63}$/i.test(state)))].sort().slice(0, 20)
      : [];
    if (!service || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(service)) continue;
    if (!Number.isSafeInteger(containers) || containers < 0 || containers > 1000) continue;
    output.push({ service, containers, states });
  }
  return output.sort((a, b) => a.service.localeCompare(b.service));
}

function observationConfidence(result: ActionResult): number {
  if (AMBIGUOUS_ERROR.test(result.error?.code ?? '')) return 0;
  return result.ok ? 1 : 0.5;
}
function evidenceRef(item: Evidence): string {
  return sha256(canonicalJson({ kind: item.kind, status: item.status, timestamp: item.timestamp }));
}
function isSafeScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'boolean' || typeof value === 'number'
    || (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/.test(value));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4096 ? value : undefined;
}
function bounded(value: string, max: number): string {
  return value.slice(0, max).replace(/[\r\n\0]/g, ' ');
}
function browserDestinationDigest(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return sha256(`${parsed.origin}${pathname}${parsed.search}`);
  } catch {
    return undefined;
  }
}
function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
