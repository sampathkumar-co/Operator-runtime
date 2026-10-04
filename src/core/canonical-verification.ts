import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { AgentKernel } from './agent-kernel.ts';
import { kernelVerificationDigest } from './action-verification.ts';
import { OperatorError } from './errors.ts';
import { normalizeMachineObservation } from './machine-state.ts';
import { assertTaskMachineState, normalizeTaskStateAssertions, type TaskStateAssertion } from './task-state-assertion.ts';
import type { IntentBinding, PermissionProfile } from './types.ts';
import type { VerificationCheck } from './verification-kernel.ts';

export interface CanonicalVerificationProbe {
  name: string;
  capability: string;
  input: Record<string, unknown>;
  target?: string;
  assertions: TaskStateAssertion[];
}

export interface CanonicalVerificationRequest {
  probes: CanonicalVerificationProbe[];
}

export function normalizeCanonicalVerificationRequest(input: unknown): CanonicalVerificationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification must be a typed read-only probe request.');
  }
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.probes) || raw.probes.length < 1 || raw.probes.length > 20) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification requires 1-20 typed read-only probes.');
  }
  const names = new Set<string>();
  const probes = raw.probes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', `probes[${index}] is invalid.`);
    }
    const probe = item as Record<string, unknown>;
    const name = bounded(probe.name, 128, `probes[${index}].name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) || names.has(name)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Probe names must be unique bounded identifiers.');
    }
    names.add(name);
    const capability = bounded(probe.capability, 256, `probes[${index}].capability`);
    const probeInput = probe.input && typeof probe.input === 'object' && !Array.isArray(probe.input)
      ? structuredClone(probe.input as Record<string, unknown>)
      : undefined;
    if (!probeInput || Buffer.byteLength(canonicalJson(probeInput)) > 256 * 1024) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', `probes[${index}].input is invalid or too large.`);
    }
    const target = probe.target === undefined ? undefined : bounded(probe.target, 4096, `probes[${index}].target`);
    const assertions = normalizeTaskStateAssertions(probe.assertions, `probes[${index}].assertions`);
    return { name, capability, input: probeInput, ...(target ? { target } : {}), assertions };
  });
  return { probes };
}

export async function executeCanonicalVerification(input: {
  request: unknown;
  kernel: AgentKernel;
  permissions: PermissionProfile;
  subjectKind: string;
  subjectId: string;
  ownerKind: string;
  ownerId: string;
  intent?: IntentBinding;
}): Promise<{ request: CanonicalVerificationRequest; checks: VerificationCheck[] }> {
  const request = normalizeCanonicalVerificationRequest(input.request);
  const checks: VerificationCheck[] = [];
  for (const probe of request.probes) {
    const probeDigest = digest({
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      intent: input.intent ?? null,
      probe
    });
    const action = {
      id: `canonical-verify:${probeDigest}`,
      capability: probe.capability,
      risk: 'read' as const,
      input: structuredClone(probe.input),
      provenance: { kind: 'runtime' as const, source: `canonical-verification:${input.subjectKind}` },
      ...(probe.target ? { target: probe.target } : {}),
      ...(input.intent ? { intent: input.intent } : {})
    };
    const result = await input.kernel.execute(action, input.permissions, {
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      learningContext: `verification:${input.subjectKind}`
    });
    const verificationDigest = kernelVerificationDigest(result);
    const observation = normalizeMachineObservation(action, result);
    let passed = result.ok && Boolean(verificationDigest) && !observation.ambiguous && observation.confidence === 1;
    if (passed) {
      try {
        assertTaskMachineState(observation.importantState, probe.assertions);
      } catch {
        passed = false;
      }
    }
    checks.push({
      name: `runtime-probe:${probe.name}`,
      ok: passed,
      detail: passed
        ? 'A fresh read-only Agent Kernel observation satisfied every declared machine-state assertion.'
        : 'Fresh authoritative machine state did not satisfy this verification probe.',
      evidenceDigests: [
        probeDigest,
        observation.stateVersion,
        digest(result.evidence),
        ...(verificationDigest ? [verificationDigest] : [])
      ]
    });
  }
  return { request, checks };
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function bounded(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > max || /[\r\n\0]/.test(input)) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', `${label} is invalid.`);
  }
  return input;
}
