import path from 'node:path';
import { OperatorError } from './errors.ts';
import { withDurableStateLock } from './durable-state-lock.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

export interface EnterpriseIdentityProvider {
  id: string;
  issuer: string;
  audiences: string[];
  enabled: boolean;
}

export interface EnterpriseIdentitySubject {
  providerId: string;
  subject: string;
  principalId: string;
  email?: string;
  roleIds: string[];
  groups: string[];
  enabled: boolean;
  scimExternalId?: string;
}

interface EnterpriseIdentityState {
  version: 1;
  providers: EnterpriseIdentityProvider[];
  subjects: EnterpriseIdentitySubject[];
}

const OPTIONS = {
  maxBytes: 8 * 1024 * 1024,
  errorCode: 'ENTERPRISE_IDENTITY_CORRUPT',
  invalidMessage: 'Enterprise identity state is invalid.'
} as const;

export class EnterpriseIdentityStore {
  #file: string;
  #serial: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.#file = path.join(path.resolve(stateDir), 'enterprise-identity.json');
  }

  async configureProviders(providersInput: EnterpriseIdentityProvider[]): Promise<void> {
    const providers = normalizeProviders(providersInput);
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      state.providers = providers;
      await this.#write(state);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async upsertScimUser(input: {
    providerId: string;
    subject: string;
    principalId: string;
    email?: string;
    roleIds?: string[];
    groups?: string[];
    externalId?: string;
    active?: boolean;
  }): Promise<EnterpriseIdentitySubject> {
    const subject = normalizeSubject({
      providerId: input.providerId,
      subject: input.subject,
      principalId: input.principalId,
      ...(input.email ? { email: input.email } : {}),
      roleIds: input.roleIds ?? [],
      groups: input.groups ?? [],
      enabled: input.active !== false,
      ...(input.externalId ? { scimExternalId: input.externalId } : {})
    });
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      if (!state.providers.some((provider) => provider.id === subject.providerId && provider.enabled)) {
        throw new OperatorError('ENTERPRISE_IDP_UNKNOWN', 'SCIM subject references an unknown or disabled identity provider.');
      }
      const index = state.subjects.findIndex((item) => item.providerId === subject.providerId && item.subject === subject.subject);
      if (index >= 0) state.subjects[index] = subject; else state.subjects.push(subject);
      state.subjects.sort((a,b)=>identityKey(a).localeCompare(identityKey(b)));
      await this.#write(state);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
    return structuredClone(subject);
  }

  async deactivateScimUser(providerIdInput: string, subjectInput: string): Promise<void> {
    const providerId = id(providerIdInput,'providerId'), subject = text(subjectInput,512,'subject');
    const run = this.#serial.then(() => withDurableStateLock(this.#file, async () => {
      const state = await this.#read();
      const record = state.subjects.find((item) => item.providerId === providerId && item.subject === subject);
      if (!record) throw new OperatorError('ENTERPRISE_IDENTITY_NOT_FOUND', 'Identity subject was not found.');
      record.enabled = false;
      await this.#write(state);
    }));
    this.#serial = run.then(() => undefined, () => undefined);
    await run;
  }

  async resolveSso(input: {
    providerId: string;
    issuer: string;
    audience: string;
    subject: string;
    verified: boolean;
  }): Promise<EnterpriseIdentitySubject> {
    if (input.verified !== true) throw new OperatorError('ENTERPRISE_SSO_UNVERIFIED', 'SSO claims must be cryptographically verified before identity resolution.');
    await this.#serial;
    const state = await this.#read();
    const providerId = id(input.providerId,'providerId');
    const provider = state.providers.find((item) => item.id === providerId && item.enabled);
    if (!provider || provider.issuer !== input.issuer || !provider.audiences.includes(input.audience)) {
      throw new OperatorError('ENTERPRISE_SSO_PROVIDER_MISMATCH', 'SSO issuer or audience is not trusted for this provider.');
    }
    const subject = state.subjects.find((item) => item.providerId === providerId && item.subject === input.subject && item.enabled);
    if (!subject) throw new OperatorError('ENTERPRISE_SSO_SUBJECT_DENIED', 'SSO subject is not provisioned or is disabled.');
    return structuredClone(subject);
  }

  async inspect(): Promise<EnterpriseIdentityState> {
    await this.#serial;
    return structuredClone(await this.#read());
  }

  async #read(): Promise<EnterpriseIdentityState> {
    try { return validateState(JSON.parse(await readDurableStateText(this.#file, OPTIONS))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, providers: [], subjects: [] };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('ENTERPRISE_IDENTITY_CORRUPT', 'Enterprise identity state could not be read.');
    }
  }

  async #write(state: EnterpriseIdentityState): Promise<void> {
    validateState(state);
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), OPTIONS);
  }
}

function normalizeProviders(input: EnterpriseIdentityProvider[]): EnterpriseIdentityProvider[] {
  if(!Array.isArray(input)||input.length>1000) throw invalid('Identity providers are invalid.');
  const providers=input.map((p)=>({id:id(p.id,'provider id'),issuer:url(p.issuer,'issuer'),audiences:list(p.audiences,64,'audiences'),enabled:p.enabled===true}));
  if(new Set(providers.map((p)=>p.id)).size!==providers.length) throw invalid('Identity provider IDs must be unique.');
  return providers.sort((a,b)=>a.id.localeCompare(b.id));
}
function normalizeSubject(s:EnterpriseIdentitySubject):EnterpriseIdentitySubject{
  return {providerId:id(s.providerId,'providerId'),subject:text(s.subject,512,'subject'),principalId:id(s.principalId,'principalId'),
    ...(s.email?{email:text(s.email,512,'email')}:{ }),roleIds:list(s.roleIds,256,'roleIds'),groups:list(s.groups,1024,'groups'),enabled:s.enabled===true,
    ...(s.scimExternalId?{scimExternalId:text(s.scimExternalId,512,'scimExternalId')}:{})};
}
function validateState(input:unknown):EnterpriseIdentityState{
  if(!input||typeof input!=='object'||Array.isArray(input))throw corrupt('State must be an object.');
  const s=input as EnterpriseIdentityState;
  if(s.version!==1)throw corrupt('State version is invalid.');
  // Fail closed on missing persisted collections or approval state. Defaulting an
  // absent subjects array to [] can turn a damaged file into a valid empty SCIM
  // database and overwrite the original identities on the next upsert.
  if (!Array.isArray(s.providers) || !Array.isArray(s.subjects)) throw corrupt('Identity providers and subjects are required.');
  if (s.providers.some((provider) => !provider || typeof provider !== 'object' || typeof provider.enabled !== 'boolean')
    || s.subjects.some((subject) => !subject || typeof subject !== 'object' || typeof subject.enabled !== 'boolean')) {
    throw corrupt('Persisted identity enabled flags must be explicit booleans.');
  }
  const providers=normalizeProviders(s.providers), subjects=s.subjects.map(normalizeSubject);
  if(subjects.length>100_000)throw corrupt('Too many identity subjects.');
  if(new Set(subjects.map(identityKey)).size!==subjects.length)throw corrupt('Identity subjects must be unique.');
  return{version:1,providers,subjects};
}
function identityKey(s:Pick<EnterpriseIdentitySubject,'providerId'|'subject'>):string{return s.providerId+'\0'+s.subject;}
function list(v:unknown,max:number,label:string):string[]{if(!Array.isArray(v)||v.length>max)throw invalid(label+' is invalid.');return[...new Set(v.map((x)=>id(x,label)))].sort();}
function id(v:unknown,label:string):string{if(typeof v!=='string'||!/^[A-Za-z0-9._:@/-]{1,256}$/.test(v))throw invalid(label+' is invalid.');return v;}
function text(v:unknown,max:number,label:string):string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v,'utf8')>max||v.includes('\0'))throw invalid(label+' is invalid.');return v;}
function url(v:unknown,label:string):string{const s=text(v,2048,label);let u:URL;try{u=new URL(s);}catch{throw invalid(label+' is invalid.');}if(u.protocol!=='https:')throw invalid(label+' must use HTTPS.');return u.toString().replace(/\/$/,'');}
function invalid(m:string):OperatorError{return new OperatorError('ENTERPRISE_IDENTITY_INVALID',m);}
function corrupt(m:string):OperatorError{return new OperatorError('ENTERPRISE_IDENTITY_CORRUPT',m);}
