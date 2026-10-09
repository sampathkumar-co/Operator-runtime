import crypto from 'node:crypto';

/** Immutable child identities shared by provider preparation and adjudication. */
export function stableOrganizationMissionId(programId: string, targetKey: string): string {
  const bytes = crypto.createHash('sha256').update(`organization-mission\0${programId}\0${targetKey}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function organizationCompensationIntentId(programId: string, operation: string, targetId: string): string {
  const digest = crypto.createHash('sha256').update(`${programId}\0${operation}\0${targetId}`, 'utf8').digest('hex');
  return `organization:${digest}`;
}
