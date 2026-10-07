import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';
import { assertAttenuates, type AuthorityGrant } from './principal-delegation.ts';

export type EnterpriseAuthorityLeaseState = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'HALTED';

export interface EnterpriseAuthorityLease {
  id: string;
  principalId: string;
  purpose: string;
  grant: AuthorityGrant;
  authorityRevision: number;
  parentLeaseId?: string;
  issuedAt: string;
  expiresAt: string;
  state: EnterpriseAuthorityLeaseState;
  revokedAt?: string;
  revocationReason?: string;
}

interface AuthorityLeaseStateFile {
  version: 1;
  emergencyHalt: boolean;
  emergencyReason?: string;
  leases: EnterpriseAuthorityLease[];
}

const OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'ENTERPRISE_AUTHORITY_LEASE_CORRUPT',
  invalidMessage: 'Enterprise authority lease state is invalid.'
} as const;

const MAX_TTL_MS = 24 * 60 * 60_000;

export class EnterpriseAuthorityLeaseStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();
  #clock: () => Date;

  constructor(stateDir: string, options: { clock?: () => Date } = {}) {
    this.#file = path.join(path.resolve(stateDir), 'enterprise-authority-leases.json');
    this.#clock = options.clock ?? (() => new Date());
  }

  async issue(input: {
    principalId: string;
    purpose: string;
    grant: AuthorityGrant;
    authorityRevision: number;
    ttlMs: number;
    parentLeaseId?: string;
  }): Promise<EnterpriseAuthorityLease> {
    const principalId = boundedId(input.principalId, 'principalId');
    const purpose = boundedText(input.purpose, 2048, 'purpose');
    const authorityRevision = boundedInteger(input.authorityRevision, 1, Number.MAX_SAFE_INTEGER, 'authorityRevision');
    const ttlMs = boundedInteger(input.ttlMs, 1_000, MAX_TTL_MS, 'ttlMs');
    let created!: EnterpriseAuthorityLease;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      const now = this.#clock();
      expire(state, now);
      if (state.emergencyHalt) throw new OperatorError('ENTERPRISE_EMERGENCY_HALTED', 'Enterprise authority issuance is disabled by emergency halt.');
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const grant: AuthorityGrant = { ...input.grant, expiresAt };
      if (input.parentLeaseId) {
        const parent = state.leases.find((item) => item.id === input.parentLeaseId);
        if (!parent || parent.state !== 'ACTIVE') throw new OperatorError('ENTERPRISE_PARENT_LEASE_INVALID', 'Parent authority lease is not active.');
        if (Date.parse(parent.expiresAt) <= now.getTime()) throw new OperatorError('ENTERPRISE_PARENT_LEASE_EXPIRED', 'Parent authority lease is expired.');
        assertAttenuates(parent.grant, grant, 'authority lease');
      }
      created = {
        id: crypto.randomUUID(),
        principalId,
        purpose,
        grant,
        authorityRevision,
        ...(input.parentLeaseId ? { parentLeaseId: input.parentLeaseId } : {}),
        issuedAt: now.toISOString(),
        expiresAt,
        state: 'ACTIVE'
      };
      state.leases.push(created);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(created);
  }

  async assertActive(idInput: string, expected: { principalId?: string; purpose?: string; authorityRevision?: number } = {}): Promise<EnterpriseAuthorityLease> {
    await this.#serial;
    const state = await this.#read();
    expire(state, this.#clock());
    if (state.emergencyHalt) throw new OperatorError('ENTERPRISE_EMERGENCY_HALTED', 'Enterprise authority is disabled by emergency halt.');
    const id = uuid(idInput, 'leaseId');
    const lease = state.leases.find((item) => item.id === id);
    if (!lease || lease.state !== 'ACTIVE') throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_INACTIVE', 'Enterprise authority lease is not active.');
    if (expected.principalId !== undefined && lease.principalId !== expected.principalId) throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_MISMATCH', 'Authority lease principal does not match.');
    if (expected.purpose !== undefined && lease.purpose !== expected.purpose) throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_MISMATCH', 'Authority lease purpose does not match.');
    if (expected.authorityRevision !== undefined && lease.authorityRevision !== expected.authorityRevision) throw new OperatorError('ENTERPRISE_AUTHORITY_STALE', 'Authority revision changed after lease issuance.');
    return structuredClone(lease);
  }

  async revoke(idInput: string, reasonInput: string): Promise<EnterpriseAuthorityLease> {
    const id = uuid(idInput, 'leaseId');
    const reason = boundedText(reasonInput, 2048, 'reason');
    let revoked!: EnterpriseAuthorityLease;
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      expire(state, this.#clock());
      const lease = state.leases.find((item) => item.id === id);
      if (!lease) throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_NOT_FOUND', 'Enterprise authority lease was not found.');
      if (lease.state === 'ACTIVE') {
        lease.state = 'REVOKED';
        lease.revokedAt = this.#clock().toISOString();
        lease.revocationReason = reason;
      }
      revoked = structuredClone(lease);
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return revoked;
  }

  async emergencyHalt(reasonInput: string): Promise<void> {
    const reason = boundedText(reasonInput, 2048, 'reason');
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      state.emergencyHalt = true;
      state.emergencyReason = reason;
      const at = this.#clock().toISOString();
      for (const lease of state.leases) {
        if (lease.state === 'ACTIVE') {
          lease.state = 'HALTED';
          lease.revokedAt = at;
          lease.revocationReason = reason;
        }
      }
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async clearEmergencyHalt(): Promise<void> {
    const run = this.#serial.then(async () => {
      const state = await this.#read();
      state.emergencyHalt = false;
      delete state.emergencyReason;
      await this.#write(state);
    });
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async list(): Promise<EnterpriseAuthorityLease[]> {
    await this.#serial;
    const state = await this.#read();
    expire(state, this.#clock());
    return state.leases.map((item) => structuredClone(item));
  }

  async #read(): Promise<AuthorityLeaseStateFile> {
    try {
      return validateState(JSON.parse(await readDurableStateText(this.#file, OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, emergencyHalt: false, leases: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_CORRUPT', 'Enterprise authority lease state could not be read.');
    }
  }

  async #write(state: AuthorityLeaseStateFile): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
  }
}

function expire(state: AuthorityLeaseStateFile, now: Date): void {
  for (const lease of state.leases) if (lease.state === 'ACTIVE' && Date.parse(lease.expiresAt) <= now.getTime()) lease.state = 'EXPIRED';
}

function validateState(input: unknown): AuthorityLeaseStateFile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw corrupt('State must be an object.');
  const value = input as AuthorityLeaseStateFile;
  if (value.version !== 1 || typeof value.emergencyHalt !== 'boolean' || !Array.isArray(value.leases) || value.leases.length > 100_000) throw corrupt('State shape is invalid.');
  const ids = new Set<string>();
  for (const lease of value.leases) {
    uuid(lease.id, 'lease id'); boundedId(lease.principalId, 'principalId'); boundedText(lease.purpose, 2048, 'purpose');
    boundedInteger(lease.authorityRevision, 1, Number.MAX_SAFE_INTEGER, 'authorityRevision');
    if (ids.has(lease.id)) throw corrupt('Lease IDs must be unique.'); ids.add(lease.id);
    if (!['ACTIVE','REVOKED','EXPIRED','HALTED'].includes(lease.state)) throw corrupt('Lease state is invalid.');
    canonicalIso(lease.issuedAt, 'issuedAt'); canonicalIso(lease.expiresAt, 'expiresAt');
    if (lease.parentLeaseId !== undefined) uuid(lease.parentLeaseId, 'parentLeaseId');
  }
  return structuredClone(value);
}

function boundedId(v: unknown, label: string): string { const s=String(v??''); if(!/^[A-Za-z0-9._:@/-]{1,256}$/.test(s)) throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_INVALID', label+' is invalid.'); return s; }
function boundedText(v: unknown, max: number, label: string): string { if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max||v.includes('\0')) throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_INVALID', label+' is invalid.'); return v; }
function boundedInteger(v: unknown, min:number,max:number,label:string):number{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_INVALID',label+' is invalid.');return n;}
function uuid(v: unknown,label:string):string{const s=String(v??'').toLowerCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s))throw new OperatorError('ENTERPRISE_AUTHORITY_LEASE_INVALID',label+' must be UUID.');return s;}
function canonicalIso(v: unknown,label:string):string{const s=String(v??'');if(!Number.isFinite(Date.parse(s))||new Date(s).toISOString()!==s)throw corrupt(label+' is invalid.');return s;}
function corrupt(message:string):OperatorError{return new OperatorError('ENTERPRISE_AUTHORITY_LEASE_CORRUPT',message);}
