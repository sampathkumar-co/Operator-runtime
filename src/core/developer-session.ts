import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { readDurableStateText, writeDurableStateText } from './durable-state.ts';

export type DeveloperSessionStatus = 'PLANNING' | 'ACTIVE' | 'PAUSED' | 'BLOCKED' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface DeveloperSession {
  schemaVersion: 1;
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  workspaceRootNodeId: string;
  workspaceGraphId?: string;
  planRef?: { taskId: string; revision: number };
  taskIds: string[];
  artifactIds: string[];
  approvalIds: string[];
  checkpointIds: string[];
  status: DeveloperSessionStatus;
  resumeSummary?: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const OPTIONS = {
  maxBytes: MAX_BYTES,
  errorCode: 'DEVELOPER_SESSION_CORRUPT',
  invalidMessage: 'Developer Session state is invalid.'
} as const;
const ID = /^[A-Za-z0-9._:@/+\-=]{1,512}$/;
const LEGACY_FILENAME_SAFE_ID = /^[A-Za-z0-9._:@+\-=]{1,512}$/;

export function createDeveloperSession(input: {
  objective: string;
  acceptanceCriteria: string[];
  constraints?: string[];
  workspaceRootNodeId: string;
  workspaceGraphId?: string;
  now?: string;
}): DeveloperSession {
  const now = canonicalIso(input.now ?? new Date().toISOString(), 'now');
  return normalizeDeveloperSession({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints ?? [],
    workspaceRootNodeId: input.workspaceRootNodeId,
    ...(input.workspaceGraphId ? { workspaceGraphId: input.workspaceGraphId } : {}),
    taskIds: [],
    artifactIds: [],
    approvalIds: [],
    checkpointIds: [],
    status: 'PLANNING',
    createdAt: now,
    updatedAt: now
  });
}

export function normalizeDeveloperSession(input: unknown): DeveloperSession {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Developer Session must be an object.');
  const raw = structuredClone(input) as DeveloperSession;
  if (raw.schemaVersion !== 1) throw invalid('Developer Session schemaVersion must be 1.');
  const id = validId(raw.id, 'session id');
  const objective = boundedText(raw.objective, 16_384, 'objective');
  const acceptanceCriteria = boundedList(raw.acceptanceCriteria, 1000, 16_384, 'acceptanceCriteria', true);
  const constraints = boundedList(raw.constraints, 2000, 16_384, 'constraints', false);
  const workspaceRootNodeId = validId(raw.workspaceRootNodeId, 'workspaceRootNodeId');
  const workspaceGraphId = raw.workspaceGraphId === undefined ? undefined : digest(raw.workspaceGraphId, 'workspaceGraphId');
  const planRef = raw.planRef === undefined ? undefined : normalizePlanRef(raw.planRef);
  const status = normalizeStatus(raw.status);
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw invalid('updatedAt cannot precede createdAt.');
  const resumeSummary = raw.resumeSummary === undefined ? undefined : boundedText(raw.resumeSummary, 16_384, 'resumeSummary');
  return {
    schemaVersion: 1,
    id,
    objective,
    acceptanceCriteria,
    constraints,
    workspaceRootNodeId,
    ...(workspaceGraphId ? { workspaceGraphId } : {}),
    ...(planRef ? { planRef } : {}),
    taskIds: idList(raw.taskIds, 5000, 'taskIds'),
    artifactIds: digestList(raw.artifactIds, 20_000, 'artifactIds'),
    approvalIds: idList(raw.approvalIds, 5000, 'approvalIds'),
    checkpointIds: idList(raw.checkpointIds, 5000, 'checkpointIds'),
    status,
    ...(resumeSummary ? { resumeSummary } : {}),
    createdAt,
    updatedAt
  };
}

export class DeveloperSessionStore {
  #dir: string;

  constructor(stateDir: string) {
    this.#dir = path.join(path.resolve(stateDir), 'developer-sessions');
  }

  async put(sessionInput: DeveloperSession): Promise<void> {
    const session = normalizeDeveloperSession(sessionInput);
    await this.#init();
    await writeDurableStateText(
      this.#hashedFile(session.id),
      JSON.stringify(session, null, 2),
      OPTIONS
    );
  }

  async get(idInput: string): Promise<DeveloperSession> {
    const id = validId(idInput, 'session id');
    await this.#init();

    const hashed = this.#hashedFile(id);
    try {
      return await this.#readFile(hashed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof OperatorError) throw error;
        throw invalid('Developer Session could not be read.');
      }
    }

    const legacy = this.#legacyFile(id);
    if (legacy) {
      try {
        return await this.#readFile(legacy);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof OperatorError) throw error;
          throw invalid('Developer Session could not be read.');
        }
      }
    }

    throw new OperatorError(
      'DEVELOPER_SESSION_NOT_FOUND',
      `Developer Session ${id} was not found.`
    );
  }

  async list(limitInput = 100): Promise<DeveloperSession[]> {
    await this.#init();
    const limit = Math.min(
      Math.max(Number.isSafeInteger(limitInput) ? limitInput : 100, 1),
      1000
    );
    const names = (await fs.readdir(this.#dir))
      .filter((name) => name.endsWith('.json'))
      .sort();

    const byId = new Map<string, DeveloperSession>();
    for (const name of names) {
      const file = path.join(this.#dir, name);
      let session: DeveloperSession;
      try {
        session = await this.#readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const prior = byId.get(session.id);
      if (!prior || session.updatedAt > prior.updatedAt) byId.set(session.id, session);
    }

    return [...byId.values()]
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async #readFile(file: string): Promise<DeveloperSession> {
    try {
      return normalizeDeveloperSession(
        JSON.parse(await readDurableStateText(file, OPTIONS))
      );
    } catch (error) {
      if (error instanceof SyntaxError) throw invalid('Developer Session contains invalid JSON.');
      throw error;
    }
  }

  async #init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw invalid('Developer Session state directory must be a real directory.');
    }
  }

  #hashedFile(id: string): string {
    const safeId = validId(id, 'session id');
    const key = crypto.createHash('sha256').update(safeId, 'utf8').digest('hex');
    return path.join(this.#dir, key + '.json');
  }

  #legacyFile(id: string): string | undefined {
    if (!LEGACY_FILENAME_SAFE_ID.test(id)) return undefined;
    return path.join(this.#dir, id + '.json');
  }
}

export function updateDeveloperSession(
  sessionInput: DeveloperSession,
  patch: Partial<Pick<DeveloperSession, 'workspaceGraphId' | 'planRef' | 'taskIds' | 'artifactIds' | 'approvalIds' | 'checkpointIds' | 'status' | 'resumeSummary'>>,
  now = new Date().toISOString()
): DeveloperSession {
  const session = normalizeDeveloperSession(sessionInput);
  return normalizeDeveloperSession({ ...session, ...patch, updatedAt: canonicalIso(now, 'updatedAt') });
}

function normalizePlanRef(input: unknown): { taskId: string; revision: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('planRef is invalid.');
  const raw = input as Record<string, unknown>;
  const taskId = validId(raw.taskId, 'planRef.taskId');
  const revision = Number(raw.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw invalid('planRef.revision is invalid.');
  return { taskId, revision };
}

function normalizeStatus(input: unknown): DeveloperSessionStatus {
  const allowed: DeveloperSessionStatus[] = ['PLANNING','ACTIVE','PAUSED','BLOCKED','VERIFYING','COMPLETED','FAILED','CANCELLED'];
  if (typeof input !== 'string' || !allowed.includes(input as DeveloperSessionStatus)) throw invalid('Developer Session status is invalid.');
  return input as DeveloperSessionStatus;
}

function idList(input: unknown, max: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw invalid(`${label} is invalid.`);
  return [...new Set(input.map((item) => validId(item, label)))].sort();
}

function digestList(input: unknown, max: number, label: string): string[] {
  if (!Array.isArray(input) || input.length > max) throw invalid(`${label} is invalid.`);
  return [...new Set(input.map((item) => digest(item, label)))].sort();
}

function boundedList(input: unknown, maxItems: number, maxBytes: number, label: string, requireOne: boolean): string[] {
  if (!Array.isArray(input) || input.length > maxItems || (requireOne && input.length < 1)) throw invalid(`${label} is invalid.`);
  return [...new Set(input.map((item) => boundedText(item, maxBytes, label)))];
}

function validId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !ID.test(input)) throw invalid(`${label} is invalid.`);
  return input;
}

function digest(input: unknown, label: string): string {
  const text = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw invalid(`${label} contains an invalid digest.`);
  return text;
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input,'utf8') > maxBytes) throw invalid(`${label} is invalid.`);
  return input;
}

function canonicalIso(input: unknown, label: string): string {
  const text = String(input ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) throw invalid(`${label} must be canonical ISO.`);
  return text;
}

function invalid(message: string): OperatorError {
  return new OperatorError('DEVELOPER_SESSION_INVALID', message);
}
