import crypto from 'node:crypto';
import { canonicalJson } from '../../../src/core/action-identity.ts';
import type { TaskCapsule } from '../../../src/core/task.ts';
import type { ControlCenterProductSnapshot } from './control-center-product.ts';

export interface ControlCenterSupportBundle {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  productVersion: string;
  sourceCommit?: string;
  product: {
    health: ControlCenterProductSnapshot['health'];
    onboardingNextStep?: string;
  };
  runtime: {
    relayState?: string;
    relayConfigured?: boolean;
    relayRequired?: boolean;
    continuity?: string;
  };
  configuration: Record<string, boolean | number>;
  failures: Array<{ code: string; count: number }>;
}

const SAFE_SETTING = /^(?:recoveryConfigured|browserAutoLaunch|cdpEndpointConfigured|browserPathConfigured|projectCommandRegistryConfigured|dockerConfigured|postgresConfigured|vscodeConfigured|windowsUiaConfigured|studioWorkflowExecutorConfigured|semanticMigrationConfigured|enterprisePolicyConfigured|desiredStateReconcilerConfigured|eventRuntimeConfigured|relayConfigured|relayResultConfigured|relayTokenFileConfigured|authorizedRootCount|projectExecutableAllowlistCount|terminalExecutableAllowlistCount|recoveredStudioRunCount|desiredStateIntervalMs|eventTickIntervalMs)$/;

export function buildControlCenterSupportBundle(input: {
  productVersion: string;
  sourceCommit?: string;
  product: ControlCenterProductSnapshot;
  runtimeStatus?: Record<string, unknown>;
  settings?: Record<string, boolean | number | string | string[]>;
  tasks?: TaskCapsule[];
  generatedAt?: string;
}): ControlCenterSupportBundle {
  const generatedAt = canonicalIso(input.generatedAt ?? new Date().toISOString());
  const productVersion = bounded(input.productVersion, 128);
  const sourceCommit = input.sourceCommit === undefined ? undefined : sha(input.sourceCommit);
  const relay = object(input.runtimeStatus?.relay);
  const configuration: Record<string, boolean | number> = {};
  for (const [key, value] of Object.entries(input.settings ?? {}).sort(([a],[b]) => a.localeCompare(b))) {
    if (!SAFE_SETTING.test(key)) continue;
    if (typeof value === 'boolean') configuration[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) configuration[key] = value;
  }

  const counts = new Map<string, number>();
  for (const task of input.tasks ?? []) {
    for (const failure of task.failures ?? []) {
      const code = /^[A-Z0-9_:-]{1,256}$/.test(String(failure.code ?? '')) ? String(failure.code) : 'UNKNOWN_FAILURE';
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    for (const record of task.execution?.records ?? []) {
      if (!record.errorCode) continue;
      const code = /^[A-Z0-9_:-]{1,256}$/.test(record.errorCode) ? record.errorCode : 'UNKNOWN_FAILURE';
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const failures = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 100);

  const body = {
    schemaVersion: 1 as const,
    generatedAt,
    productVersion,
    ...(sourceCommit ? { sourceCommit } : {}),
    product: {
      health: { ...input.product.health },
      ...(input.product.onboarding.nextStep ? { onboardingNextStep: input.product.onboarding.nextStep } : {})
    },
    runtime: {
      ...(typeof relay.state === 'string' ? { relayState: bounded(relay.state, 128) } : {}),
      ...(typeof relay.configured === 'boolean' ? { relayConfigured: relay.configured } : {}),
      ...(typeof relay.required === 'boolean' ? { relayRequired: relay.required } : {}),
      ...(typeof relay.continuity === 'string' ? { continuity: bounded(relay.continuity, 128) } : {})
    },
    configuration,
    failures
  };
  return { ...body, id: crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex') };
}

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
function bounded(input: unknown, max: number): string {
  const value = String(input ?? '');
  if (!value || value.length > max || /[\r\n\0]/.test(value)) throw new Error('Support bundle scalar is invalid.');
  return value;
}
function sha(input: unknown): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error('Source commit is invalid.');
  return value;
}
function canonicalIso(input: unknown): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Support bundle timestamp is invalid.');
  return value;
}
