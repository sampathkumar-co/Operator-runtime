import type { Evidence, EvidenceStatus } from './types.ts';

export function evidence(kind: string, status: EvidenceStatus, message: string, data?: Record<string, unknown>): Evidence {
  return { kind, status, message, data, timestamp: new Date().toISOString() };
}

export function verdict(items: Evidence[]): 'VERIFIED' | 'NOT_VERIFIED' {
  return items.some((item) => item.status === 'fail') ? 'NOT_VERIFIED' : 'VERIFIED';
}
