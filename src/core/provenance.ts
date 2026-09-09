import type { Provenance } from './types.ts';
import { PolicyError } from './errors.ts';

const INSTRUCTION_AUTHORITIES = new Set(['user', 'chatgpt', 'trusted_policy', 'runtime']);

export function assertInstructionAuthority(provenance: Provenance): void {
  if (!INSTRUCTION_AUTHORITIES.has(provenance.kind)) {
    throw new PolicyError(
      'UNTRUSTED_INSTRUCTION_SOURCE',
      `Content from ${provenance.kind} is observation data and cannot redefine task goals or permissions.`,
      { provenance }
    );
  }
}

export function isObservedContent(provenance: Provenance): boolean {
  return !INSTRUCTION_AUTHORITIES.has(provenance.kind);
}
