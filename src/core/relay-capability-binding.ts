import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';

const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RelayAccountAuthority {
  accountId: string;
  deviceId: string;
  generation: number;
}

export interface RelayCapabilitySessionBinding {
  protocol: 1;
  capabilityBinding: 1;
  connectionId: string;
  logicalSessionId: string;
  deviceId: string;
  deviceFingerprint: string;
  authority: RelayAccountAuthority;
  capabilities: string[];
}

export function createRelayCapabilitySessionBinding(input: RelayCapabilitySessionBinding): Readonly<RelayCapabilitySessionBinding> {
  const binding = validateRelayCapabilitySessionBinding(input);
  return Object.freeze({
    ...binding,
    authority: Object.freeze({ ...binding.authority }),
    capabilities: Object.freeze([...binding.capabilities]) as unknown as string[]
  });
}

export function relayCapabilitySessionDigest(input: RelayCapabilitySessionBinding): string {
  const binding = validateRelayCapabilitySessionBinding(input);
  return crypto.createHash('sha256').update(JSON.stringify({
    purpose: 'operator-relay-capability-session-v1',
    protocol: binding.protocol,
    capabilityBinding: binding.capabilityBinding,
    connectionId: binding.connectionId,
    logicalSessionId: binding.logicalSessionId,
    deviceId: binding.deviceId,
    deviceFingerprint: binding.deviceFingerprint,
    authority: binding.authority,
    capabilities: binding.capabilities
  })).digest('hex');
}

export function validateRelayAccountAuthority(input: unknown): RelayAccountAuthority {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Relay account authority is missing or malformed.');
  const raw = input as Record<string, unknown>;
  const accountId = String(raw.accountId ?? '').toLowerCase();
  const deviceId = String(raw.deviceId ?? '').toLowerCase();
  const generation = Number(raw.generation);
  if (!UUID.test(accountId) || !UUID.test(deviceId) || !Number.isSafeInteger(generation) || generation < 1) {
    invalid('Relay account authority identity or generation is invalid.');
  }
  return { accountId, deviceId, generation };
}

export function validateRelayCapabilityDigest(input: unknown): string {
  const digest = String(input ?? '').toLowerCase();
  if (!SHA256.test(digest)) invalid('Relay capability session digest is invalid.');
  return digest;
}

export function sameRelayAccountAuthority(left: RelayAccountAuthority, right: RelayAccountAuthority): boolean {
  return left.accountId === right.accountId && left.deviceId === right.deviceId && left.generation === right.generation;
}

function validateRelayCapabilitySessionBinding(input: RelayCapabilitySessionBinding): RelayCapabilitySessionBinding {
  if (!input || input.protocol !== 1 || input.capabilityBinding !== 1) invalid('Relay capability session protocol is invalid.');
  const connectionId = String(input.connectionId ?? '');
  const logicalSessionId = String(input.logicalSessionId ?? '').toLowerCase();
  const deviceId = String(input.deviceId ?? '').toLowerCase();
  const deviceFingerprint = String(input.deviceFingerprint ?? '');
  if (!CONNECTION_ID.test(connectionId) || !UUID.test(logicalSessionId) || !UUID.test(deviceId)) invalid('Relay capability session identity is invalid.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceFingerprint)) invalid('Relay capability session fingerprint is invalid.');
  const authority = validateRelayAccountAuthority(input.authority);
  if (authority.deviceId !== deviceId) invalid('Relay capability authority is bound to a different device.');
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 128) invalid('Relay capability session capability set is invalid.');
  const capabilities = input.capabilities.map((item) => String(item ?? ''));
  if (capabilities.some((item) => !CAPABILITY.test(item)) || new Set(capabilities).size !== capabilities.length) {
    invalid('Relay capability session capability set is invalid.');
  }
  capabilities.sort();
  return { protocol: 1, capabilityBinding: 1, connectionId, logicalSessionId, deviceId, deviceFingerprint, authority, capabilities };
}

function invalid(message: string): never {
  throw new OperatorError('RELAY_CAPABILITY_BINDING_INVALID', message, { retryable: false });
}
