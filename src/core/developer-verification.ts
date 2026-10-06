import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './action-identity.ts';
import { ArtifactStore } from './artifact-store.ts';
import {
  DeveloperSessionStore,
  updateDeveloperSession,
  type DeveloperSession
} from './developer-session.ts';
import {
  publishEvidencePack,
  type EvidencePack
} from './evidence-pack.ts';
import {
  executionContextDigest,
  normalizeExecutionContextIdentity,
  type ExecutionContextIdentity
} from './execution-context-identity.ts';
import { OperatorError } from './errors.ts';
import { ResourceLeaseStore } from './resource-leases.ts';
import {
  createDurableStateBytes,
  readDurableStateText,
  writeDurableStateText
} from './durable-state.ts';
import type { ActionRequest, ActionResult } from './types.ts';

export interface DeveloperVerificationRequirement {
  commandId: string;
  criterionIndexes: number[];
}

export interface DeveloperVerificationReceiptRef {
  commandId: string;
  artifactId: string;
  ok: boolean;
  recordedAt: string;
}

export type DeveloperVerificationStatus = 'VERIFYING' | 'VERIFIED';

export interface DeveloperVerificationRun {
  schemaVersion: 1;
  id: string;
  developerSessionId: string;
  acceptanceCriteriaDigest: string;
  requirements: DeveloperVerificationRequirement[];
  receipts: DeveloperVerificationReceiptRef[];
  status: DeveloperVerificationStatus;
  evidencePackArtifactId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperVerificationReceipt {
  schemaVersion: 1;
  runId: string;
  developerSessionId: string;
  commandId: string;
  actionId: string;
  ok: boolean;
  provider: 'project.command.trusted';
  capability: 'project.command.run';
  errorCode?: string;
  durationMs: number;
  evidence: Array<{ kind: string; status: 'pass' | 'fail' | 'info' }>;
  executionContextDigest: string;
  recordedAt: string;
}

export interface DeveloperVerificationFinalization {
  verified: boolean;
  run: DeveloperVerificationRun;
  session: DeveloperSession;
  missingCommandIds: string[];
  failedCommandIds: string[];
  evidencePack?: EvidencePack;
  evidencePackArtifactId?: string;
}

const RUN_OPTIONS = {
  maxBytes: 2 * 1024 * 1024,
  errorCode: 'DEVELOPER_VERIFICATION_RUN_CORRUPT',
  invalidMessage: 'Developer verification run state is invalid.'
} as const;
const MAX_REQUIREMENTS = 256;
const MAX_RECEIPTS = 4096;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export class DeveloperVerificationCoordinator {
  #dir: string;
  #sessions: DeveloperSessionStore;
  #artifacts: ArtifactStore;
  #leases: ResourceLeaseStore;

  constructor(stateDir: string) {
    const root = path.resolve(stateDir);
    this.#dir = path.join(root, 'developer-verification-runs');
    this.#sessions = new DeveloperSessionStore(root);
    this.#artifacts = new ArtifactStore(root);
    this.#leases = new ResourceLeaseStore(root);
  }

  async start(input: {
    developerSessionId: string;
    requirements: DeveloperVerificationRequirement[];
    now?: string;
  }): Promise<{ run: DeveloperVerificationRun; session: DeveloperSession }> {
    const session = await this.#sessions.get(input.developerSessionId);
    if (!['ACTIVE', 'VERIFYING', 'BLOCKED'].includes(session.status)) {
      throw new OperatorError(
        'DEVELOPER_VERIFICATION_SESSION_STATE_INVALID',
        'Developer verification requires an ACTIVE, VERIFYING, or BLOCKED Developer Session.',
        { details: { sessionId: session.id, status: session.status } }
      );
    }
    const requirements = normalizeRequirements(input.requirements, session.acceptanceCriteria.length);
    assertAcceptanceCoverage(requirements, session.acceptanceCriteria.length);
    const now = canonicalIso(input.now ?? new Date().toISOString(), 'now');
    const acceptanceCriteriaDigest = sha256(Buffer.from(canonicalJson(session.acceptanceCriteria), 'utf8'));
    const identity = {
      schemaVersion: 1 as const,
      developerSessionId: session.id,
      acceptanceCriteriaDigest,
      requirements
    };
    const id = sha256(Buffer.from(canonicalJson(identity), 'utf8'));
    const run: DeveloperVerificationRun = {
      ...identity,
      id,
      receipts: [],
      status: 'VERIFYING',
      createdAt: now,
      updatedAt: now
    };

    await this.#init();
    const lease = await this.#leases.acquire(
      'developer-verification-start:' + id,
      ['developer-verification:' + id],
      'exclusive'
    );
    try {
      await this.#putNewOrSame(run);
      const current = await this.#sessions.get(session.id);
      const verifying = updateDeveloperSession(
        current,
        {
          status: 'VERIFYING',
          resumeSummary: 'Verification run ' + id + ' is waiting for trusted command receipts.'
        },
        now
      );
      await this.#sessions.put(verifying);
      return { run: await this.get(id), session: verifying };
    } finally {
      await lease.release();
    }
  }

  async get(runIdInput: string): Promise<DeveloperVerificationRun> {
    const runId = digest(runIdInput, 'runId');
    await this.#init();
    try {
      return normalizeRun(JSON.parse(await readDurableStateText(this.#file(runId), RUN_OPTIONS)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OperatorError('DEVELOPER_VERIFICATION_RUN_NOT_FOUND', 'Developer verification run was not found.');
      }
      if (error instanceof OperatorError) throw error;
      throw new OperatorError(
        'DEVELOPER_VERIFICATION_RUN_CORRUPT',
        'Developer verification run could not be read.'
      );
    }
  }

  async recordAuthorizedCommandResult(input: {
    runId: string;
    action: ActionRequest;
    result: ActionResult;
    executionContext: ExecutionContextIdentity;
    now?: string;
  }): Promise<{ run: DeveloperVerificationRun; receipt: DeveloperVerificationReceipt; artifactId: string }> {
    const runId = digest(input.runId, 'runId');
    const now = canonicalIso(input.now ?? new Date().toISOString(), 'now');
    const executionContext = normalizeExecutionContextIdentity(input.executionContext);
    const lease = await this.#leases.acquire(
      'developer-verification-record:' + runId,
      ['developer-verification:' + runId],
      'exclusive'
    );
    try {
      const run = await this.get(runId);
      if (run.status !== 'VERIFYING') {
        throw new OperatorError(
          'DEVELOPER_VERIFICATION_ALREADY_FINAL',
          'Verified Developer verification run cannot accept new receipts.'
        );
      }

      const commandId = validateAuthorizedProjectCommandResult(run, input.action, input.result);
      const receipt: DeveloperVerificationReceipt = {
        schemaVersion: 1,
        runId,
        developerSessionId: run.developerSessionId,
        commandId,
        actionId: validActionId(input.action.id),
        ok: input.result.ok,
        provider: 'project.command.trusted',
        capability: 'project.command.run',
        ...(input.result.error?.code ? { errorCode: boundedCode(input.result.error.code) } : {}),
        durationMs: boundedDuration(input.result.durationMs),
        evidence: sanitizeEvidence(input.result),
        executionContextDigest: executionContextDigest(executionContext),
        recordedAt: now
      };

      const artifact = await this.#artifacts.put({
        bytes: JSON.stringify(receipt, null, 2),
        kind: 'test-report',
        mediaType: 'application/json',
        privacy: 'internal',
        executionContextDigest: receipt.executionContextDigest,
        metadata: {
          developerSessionId: run.developerSessionId,
          verificationRunId: run.id,
          commandId,
          ok: receipt.ok
        },
        now
      });

      if (!run.receipts.some((item) => item.artifactId === artifact.id)) {
        if (run.receipts.length >= MAX_RECEIPTS) {
          throw new OperatorError(
            'DEVELOPER_VERIFICATION_RECEIPT_LIMIT',
            'Developer verification run has too many receipts.'
          );
        }
        run.receipts.push({
          commandId,
          artifactId: artifact.id,
          ok: receipt.ok,
          recordedAt: now
        });
        run.receipts.sort((a, b) =>
          a.recordedAt.localeCompare(b.recordedAt) ||
          a.commandId.localeCompare(b.commandId) ||
          a.artifactId.localeCompare(b.artifactId)
        );
        run.updatedAt = now;
        await this.#writeRun(run);
      }

      const session = await this.#sessions.get(run.developerSessionId);
      const artifactIds = [...new Set([...session.artifactIds, artifact.id])].sort();
      const verifying = updateDeveloperSession(
        session,
        {
          status: 'VERIFYING',
          artifactIds,
          resumeSummary: 'Verification run ' + run.id + ' has ' + String(run.receipts.length) + ' trusted command receipt(s).'
        },
        now
      );
      await this.#sessions.put(verifying);
      return { run: await this.get(run.id), receipt, artifactId: artifact.id };
    } finally {
      await lease.release();
    }
  }

  async finalize(
    runIdInput: string,
    nowInput = new Date().toISOString()
  ): Promise<DeveloperVerificationFinalization> {
    const runId = digest(runIdInput, 'runId');
    const now = canonicalIso(nowInput, 'now');
    const lease = await this.#leases.acquire(
      'developer-verification-finalize:' + runId,
      ['developer-verification:' + runId],
      'exclusive'
    );
    try {
      const run = await this.get(runId);
      const session = await this.#sessions.get(run.developerSessionId);
      if (criteriaDigest(session.acceptanceCriteria) !== run.acceptanceCriteriaDigest) {
        throw new OperatorError(
          'DEVELOPER_VERIFICATION_CRITERIA_CHANGED',
          'Developer Session acceptance criteria no longer match this verification run.'
        );
      }

      if (run.status === 'VERIFIED' && run.evidencePackArtifactId) {
        const packArtifact = await this.#artifacts.read(run.evidencePackArtifactId);
        const pack = JSON.parse(packArtifact.bytes.toString('utf8')) as EvidencePack;
        return {
          verified: true,
          run,
          session,
          missingCommandIds: [],
          failedCommandIds: [],
          evidencePack: pack,
          evidencePackArtifactId: run.evidencePackArtifactId
        };
      }

      const latest = latestReceipts(run.receipts);
      const missingCommandIds: string[] = [];
      const failedCommandIds: string[] = [];
      for (const requirement of run.requirements) {
        const receipt = latest.get(requirement.commandId);
        if (!receipt) missingCommandIds.push(requirement.commandId);
        else if (!receipt.ok) failedCommandIds.push(requirement.commandId);
      }

      if (missingCommandIds.length > 0 || failedCommandIds.length > 0) {
        const blocked = updateDeveloperSession(
          session,
          {
            status: 'BLOCKED',
            resumeSummary:
              'Verification incomplete. Missing commands: [' + missingCommandIds.join(',') +
              ']. Failed commands: [' + failedCommandIds.join(',') + '].'
          },
          now
        );
        await this.#sessions.put(blocked);
        return {
          verified: false,
          run,
          session: blocked,
          missingCommandIds,
          failedCommandIds
        };
      }

      const artifactIds = [...new Set(run.receipts.map((item) => item.artifactId))].sort();
      const claims = session.acceptanceCriteria.map((criterion, criterionIndex) => {
        const supporting = run.requirements
          .filter((requirement) => requirement.criterionIndexes.includes(criterionIndex))
          .map((requirement) => latest.get(requirement.commandId)!)
          .map((receipt) => receipt.artifactId);
        const commandIds = run.requirements
          .filter((requirement) => requirement.criterionIndexes.includes(criterionIndex))
          .map((requirement) => requirement.commandId)
          .sort();
        return {
          id: 'acceptance-' + String(criterionIndex + 1),
          statement: criterion,
          level: 'EMPIRICALLY_VERIFIED' as const,
          artifactIds: [...new Set(supporting)].sort(),
          verifier: 'trusted-project-command:' + commandIds.join('+')
        };
      });

      const published = await publishEvidencePack(
        this.#artifacts,
        {
          executionContext: { schemaVersion: 1, sessionId: session.id },
          artifactIds,
          claims,
          residualUncertainty: [],
          rollbackStatus: 'NOT_APPLICABLE',
          now
        },
        'internal'
      );

      run.status = 'VERIFIED';
      run.evidencePackArtifactId = published.artifact.id;
      run.updatedAt = now;
      await this.#writeRun(run);

      const completed = updateDeveloperSession(
        session,
        {
          status: 'COMPLETED',
          artifactIds: [...new Set([...session.artifactIds, ...artifactIds, published.artifact.id])].sort(),
          resumeSummary: 'All acceptance criteria were empirically verified by trusted registered project commands.'
        },
        now
      );
      await this.#sessions.put(completed);

      return {
        verified: true,
        run: await this.get(run.id),
        session: completed,
        missingCommandIds: [],
        failedCommandIds: [],
        evidencePack: published.pack,
        evidencePackArtifactId: published.artifact.id
      };
    } finally {
      await lease.release();
    }
  }

  async #init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OperatorError(
        'DEVELOPER_VERIFICATION_STORE_INVALID',
        'Developer verification run directory must be a real directory.'
      );
    }
  }

  async #putNewOrSame(run: DeveloperVerificationRun): Promise<void> {
    const normalized = normalizeRun(run);
    const bytes = Buffer.from(JSON.stringify(normalized, null, 2), 'utf8');
    try {
      await createDurableStateBytes(this.#file(normalized.id), bytes, RUN_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.get(normalized.id);
      if (canonicalJson(runIdentity(existing)) !== canonicalJson(runIdentity(normalized))) {
        throw new OperatorError(
          'DEVELOPER_VERIFICATION_RUN_CONFLICT',
          'Existing verification run id refers to different immutable requirements.'
        );
      }
    }
  }

  async #writeRun(run: DeveloperVerificationRun): Promise<void> {
    const normalized = normalizeRun(run);
    await writeDurableStateText(this.#file(normalized.id), JSON.stringify(normalized, null, 2), RUN_OPTIONS);
  }

  #file(id: string): string {
    return path.join(this.#dir, digest(id, 'runId') + '.json');
  }
}

function validateAuthorizedProjectCommandResult(
  run: DeveloperVerificationRun,
  action: ActionRequest,
  result: ActionResult
): string {
  if (action.capability !== 'project.command.run') {
    throw new OperatorError(
      'DEVELOPER_VERIFICATION_ACTION_INVALID',
      'Verification receipts may only be created from project.command.run actions.'
    );
  }
  const commandId = commandIdValue(action.input.commandId);
  if (!run.requirements.some((item) => item.commandId === commandId)) {
    throw new OperatorError(
      'DEVELOPER_VERIFICATION_COMMAND_UNPLANNED',
      'Trusted command is not required by this verification run.'
    );
  }
  if (
    result.capability !== 'project.command.run' ||
    result.provider !== 'project.command.trusted' ||
    !result.evidence.some((item) => item.kind === 'command_registry' && item.status === 'pass')
  ) {
    throw new OperatorError(
      'DEVELOPER_VERIFICATION_RESULT_UNTRUSTED',
      'Command result does not prove execution through the trusted project-command provider.'
    );
  }
  return commandId;
}

function sanitizeEvidence(result: ActionResult): Array<{ kind: string; status: 'pass' | 'fail' | 'info' }> {
  if (!Array.isArray(result.evidence) || result.evidence.length > 2000) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RESULT_INVALID', 'Action evidence collection is invalid.');
  }
  return result.evidence.map((item) => ({
    kind: boundedToken(item.kind, 128, 'evidence kind'),
    status: item.status
  }));
}

function normalizeRequirements(
  input: DeveloperVerificationRequirement[],
  criterionCount: number
): DeveloperVerificationRequirement[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_REQUIREMENTS) {
    throw new OperatorError(
      'DEVELOPER_VERIFICATION_REQUIREMENTS_INVALID',
      'Verification requirements must contain 1-' + String(MAX_REQUIREMENTS) + ' commands.'
    );
  }
  const ids = new Set<string>();
  const requirements = input.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new OperatorError('DEVELOPER_VERIFICATION_REQUIREMENTS_INVALID', 'Verification requirement is invalid.');
    }
    const commandId = commandIdValue(item.commandId);
    if (ids.has(commandId)) {
      throw new OperatorError('DEVELOPER_VERIFICATION_REQUIREMENTS_INVALID', 'Verification command ids must be unique.');
    }
    ids.add(commandId);
    if (!Array.isArray(item.criterionIndexes) || item.criterionIndexes.length < 1 || item.criterionIndexes.length > criterionCount) {
      throw new OperatorError('DEVELOPER_VERIFICATION_REQUIREMENTS_INVALID', 'criterionIndexes is invalid.');
    }
    const criterionIndexes = [...new Set(item.criterionIndexes.map((value) => {
      const index = Number(value);
      if (!Number.isSafeInteger(index) || index < 0 || index >= criterionCount) {
        throw new OperatorError('DEVELOPER_VERIFICATION_REQUIREMENTS_INVALID', 'criterionIndexes contains an invalid index.');
      }
      return index;
    }))].sort((a, b) => a - b);
    return { commandId, criterionIndexes };
  });
  return requirements.sort((a, b) => a.commandId.localeCompare(b.commandId));
}

function assertAcceptanceCoverage(
  requirements: DeveloperVerificationRequirement[],
  criterionCount: number
): void {
  const covered = new Set(requirements.flatMap((item) => item.criterionIndexes));
  const missing = Array.from({ length: criterionCount }, (_, index) => index).filter((index) => !covered.has(index));
  if (missing.length > 0) {
    throw new OperatorError(
      'DEVELOPER_VERIFICATION_COVERAGE_INCOMPLETE',
      'Every acceptance criterion must be mapped to at least one trusted verification command.',
      { details: { missingCriterionIndexes: missing } }
    );
  }
}

function normalizeRun(input: unknown): DeveloperVerificationRun {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Developer verification run must be an object.');
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Developer verification run schemaVersion must be 1.');
  }
  const developerSessionId = boundedToken(raw.developerSessionId, 512, 'developerSessionId');
  const acceptanceCriteriaDigest = digest(raw.acceptanceCriteriaDigest, 'acceptanceCriteriaDigest');
  const requirements = normalizeRequirements(
    raw.requirements as DeveloperVerificationRequirement[],
    1000
  );
  const receipts = normalizeReceiptRefs(raw.receipts);
  if (!['VERIFYING', 'VERIFIED'].includes(String(raw.status))) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Developer verification status is invalid.');
  }
  const evidencePackArtifactId = raw.evidencePackArtifactId === undefined
    ? undefined
    : digest(raw.evidencePackArtifactId, 'evidencePackArtifactId');
  if (raw.status === 'VERIFIED' && !evidencePackArtifactId) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Verified run requires Evidence Pack artifact id.');
  }
  const createdAt = canonicalIso(raw.createdAt, 'createdAt');
  const updatedAt = canonicalIso(raw.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'updatedAt precedes createdAt.');
  }
  const identity = {
    schemaVersion: 1 as const,
    developerSessionId,
    acceptanceCriteriaDigest,
    requirements
  };
  const id = digest(raw.id, 'run id');
  if (id !== sha256(Buffer.from(canonicalJson(identity), 'utf8'))) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Developer verification run id does not match requirements.');
  }
  return {
    ...identity,
    id,
    receipts,
    status: raw.status as DeveloperVerificationStatus,
    ...(evidencePackArtifactId ? { evidencePackArtifactId } : {}),
    createdAt,
    updatedAt
  };
}

function normalizeReceiptRefs(input: unknown): DeveloperVerificationReceiptRef[] {
  if (!Array.isArray(input) || input.length > MAX_RECEIPTS) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Verification receipt list is invalid.');
  }
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Verification receipt reference is invalid.');
    }
    const value = raw as Record<string, unknown>;
    const commandId = commandIdValue(value.commandId);
    const artifactId = digest(value.artifactId, 'receipt artifactId');
    if (seen.has(artifactId)) {
      throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Verification receipt artifact ids must be unique.');
    }
    seen.add(artifactId);
    if (typeof value.ok !== 'boolean') {
      throw new OperatorError('DEVELOPER_VERIFICATION_RUN_CORRUPT', 'Verification receipt ok flag is invalid.');
    }
    return {
      commandId,
      artifactId,
      ok: value.ok,
      recordedAt: canonicalIso(value.recordedAt, 'recordedAt')
    };
  });
}

function latestReceipts(
  receipts: DeveloperVerificationReceiptRef[]
): Map<string, DeveloperVerificationReceiptRef> {
  const latest = new Map<string, DeveloperVerificationReceiptRef>();
  for (const receipt of receipts) {
    const prior = latest.get(receipt.commandId);
    if (
      !prior ||
      receipt.recordedAt > prior.recordedAt ||
      (receipt.recordedAt === prior.recordedAt && receipt.artifactId > prior.artifactId)
    ) {
      latest.set(receipt.commandId, receipt);
    }
  }
  return latest;
}

function runIdentity(run: DeveloperVerificationRun) {
  return {
    schemaVersion: 1 as const,
    developerSessionId: run.developerSessionId,
    acceptanceCriteriaDigest: run.acceptanceCriteriaDigest,
    requirements: run.requirements
  };
}

function criteriaDigest(criteria: string[]): string {
  return sha256(Buffer.from(canonicalJson(criteria), 'utf8'));
}

function commandIdValue(value: unknown): string {
  const commandId = String(value ?? '');
  if (!COMMAND_ID.test(commandId)) {
    throw new OperatorError('DEVELOPER_VERIFICATION_COMMAND_INVALID', 'Trusted command id is invalid.');
  }
  return commandId;
}

function validActionId(value: unknown): string {
  const actionId = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(actionId)) {
    throw new OperatorError('DEVELOPER_VERIFICATION_ACTION_INVALID', 'Action id is invalid.');
  }
  return actionId;
}

function boundedCode(value: unknown): string {
  return boundedToken(value, 256, 'error code');
}

function boundedToken(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new OperatorError('DEVELOPER_VERIFICATION_INPUT_INVALID', label + ' is invalid.');
  }
  return value;
}

function boundedDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0 || duration > 24 * 60 * 60_000) {
    throw new OperatorError('DEVELOPER_VERIFICATION_RESULT_INVALID', 'Action duration is invalid.');
  }
  return duration;
}

function digest(value: unknown, label: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!DIGEST.test(text)) {
    throw new OperatorError('DEVELOPER_VERIFICATION_INPUT_INVALID', label + ' must be SHA-256.');
  }
  return text;
}

function canonicalIso(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new OperatorError('DEVELOPER_VERIFICATION_INPUT_INVALID', label + ' must be canonical ISO.');
  }
  return text;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
