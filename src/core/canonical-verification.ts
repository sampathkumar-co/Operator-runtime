import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import type { AgentKernel } from './agent-kernel.ts';
import { kernelVerificationDigest } from './action-verification.ts';
import { OperatorError } from './errors.ts';
import { CAPABILITY_RISK_RULES } from './capability-policy.ts';
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


function exactProbeFields(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  // Inspect descriptors before reading any property: accessors, symbols and
  // non-enumerable fields must not silently affect a verifier contract.
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', label + ' must be an inert plain object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!keys.every(key => key === 'target' || Object.hasOwn(descriptors, key)) ||
      Object.entries(descriptors).some(([key, desc]) =>
        !keys.includes(key) || !('value' in desc) || !desc.enumerable)) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', label + ' has unsupported, missing or executable fields.');
  }
}

/**
 * Accept only bounded inert JSON data as independently executed read-probe
 * input. structuredClone alone accepts cyclic graphs and custom instances;
 * canonicalJson on such graphs can overflow rather than fail with a typed
 * verifier error. A read probe is never allowed to carry executable accessors.
 */
function normalizedProbeJson(value: unknown): Record<string, unknown> {
  const visited = new Set<object>();
  let nodes = 0;
  function validate(node: unknown, depth: number): void {
    if (++nodes > 8192 || depth > 16) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe JSON exceeds bounded depth or nodes.');
    }
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (!node || typeof node !== 'object') {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input must be finite JSON data.');
    }
    if (visited.has(node)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input contains a cycle.');
    }
    const proto = Object.getPrototypeOf(node);
    if (Array.isArray(node) ? proto !== Array.prototype :
        proto !== Object.prototype && proto !== null) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input must contain plain JSON objects and arrays.');
    }
    if (Object.getOwnPropertySymbols(node).length) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input cannot contain symbol fields.');
    }
    if (Array.isArray(node)) {
      // JSON.stringify turns holes into null and silently drops array extras.
      // Neither mutation may become a trusted read-probe input.
      if (node.length > 8192 || Object.keys(node).length !== node.length) {
        throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input must contain dense arrays.');
      }
      for (let i = 0; i < node.length; i += 1) {
        if (!Object.hasOwn(node, i)) {
          throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input must contain dense arrays.');
        }
      }
    }
    visited.add(node);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      // Array length is an intrinsic non-enumerable own data property.
      if (Array.isArray(node) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input contains hidden or executable properties.');
      }
      validate(descriptor.value, depth + 1);
    }
    visited.delete(node);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input must be an object.');
  }
  validate(value, 0);
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probe input exceeds byte limit.');
  }
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * The outer probe list is proof-bearing data, not an arbitrary JS collection.
 * Array.map skips holes, permitting a nominal 1-20 probe request to contain
 * fewer validated probes. Accessors and extra array keys also disappear from
 * canonical JSON. Require the exact inert, dense JSON array shape first.
 */
function exactProbeList(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > 20 ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification requires 1-20 exact dense read-only probes.');
  }
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification probes must be dense inert data.');
    }
  }
}

export function normalizeCanonicalVerificationRequest(input: unknown): CanonicalVerificationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Verification must be a typed read-only probe request.');
  }
  const raw = input as Record<string, unknown>;
  exactProbeFields(raw, ['probes'], 'Verification request');
  exactProbeList(raw.probes);
  const names = new Set<string>();
  const probes = raw.probes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', `probes[${index}] is invalid.`);
    }
    const probe = item as Record<string, unknown>;
    exactProbeFields(probe, ['name', 'capability', 'input', 'target', 'assertions'], `probes[${index}]`);
    const name = bounded(probe.name, 128, `probes[${index}].name`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) || names.has(name)) {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', 'Probe names must be unique bounded identifiers.');
    }
    names.add(name);
    const capability = bounded(probe.capability, 256, `probes[${index}].capability`);
    // The verifier must never reinterpret a write, external, dynamic or
    // extension operation as read-only by labeling the issued action 'read'.
    // Only canonical built-in read capabilities may act as independent probes.
    if (!Object.hasOwn(CAPABILITY_RISK_RULES, capability) || CAPABILITY_RISK_RULES[capability] !== 'read') {
      throw new OperatorError('CANONICAL_VERIFICATION_INVALID', `probes[${index}].capability is not a registered read-only verification probe.`);
    }
    const probeInput = normalizedProbeJson(probe.input);
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
