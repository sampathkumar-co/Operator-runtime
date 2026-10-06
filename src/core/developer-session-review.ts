import crypto from 'node:crypto';
import { canonicalJson } from './action-identity.ts';
import { ArtifactStore } from './artifact-store.ts';
import {
  DeveloperSessionStore,
  updateDeveloperSession,
  type DeveloperSession
} from './developer-session.ts';
import { executionContextDigest } from './execution-context-identity.ts';
import { OperatorError } from './errors.ts';

export interface DeveloperResumeManifest {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  objectiveDigest: string;
  acceptanceCriteriaDigest: string;
  constraintsDigest: string;
  workspaceRootNodeId: string;
  workspaceGraphId?: string;
  planRef?: { taskId: string; revision: number };
  taskIds: string[];
  artifactIds: string[];
  approvalIds: string[];
  checkpointIds: string[];
  activeResourceKeys: string[];
  statusBeforePause: string;
  resumeSummary: string;
  createdAt: string;
}

export interface DeveloperExternalReviewSummary {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  status: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  workspaceGraphId?: string;
  planRef?: { taskId: string; revision: number };
  activeResourceKeys: string[];
  artifactIds: string[];
  checkpointIds: string[];
  approvalIds: string[];
  evidencePackArtifactId?: string;
  resumeManifestArtifactId?: string;
  createdAt: string;
}

export class DeveloperSessionReviewCoordinator {
  #sessions: DeveloperSessionStore;
  #artifacts: ArtifactStore;

  constructor(stateDir: string) {
    this.#sessions = new DeveloperSessionStore(stateDir);
    this.#artifacts = new ArtifactStore(stateDir);
  }

  async pause(input: {
    sessionId: string;
    resumeSummary: string;
    activeResourceKeys?: string[];
    now?: string;
  }): Promise<{
    session: DeveloperSession;
    manifest: DeveloperResumeManifest;
    artifactId: string;
  }> {
    const now = canonicalIso(input.now ?? new Date().toISOString());
    const current = await this.#sessions.get(input.sessionId);
    if (!['ACTIVE', 'BLOCKED', 'VERIFYING'].includes(current.status)) {
      throw new OperatorError(
        'DEVELOPER_SESSION_PAUSE_STATE_INVALID',
        'Only ACTIVE, BLOCKED, or VERIFYING Developer Sessions may be paused.'
      );
    }
    const staged = updateDeveloperSession(current, {
      activeResourceKeys: input.activeResourceKeys ?? current.activeResourceKeys,
      resumeSummary: boundedText(input.resumeSummary, 16_384, 'resumeSummary')
    }, now);

    for (const artifactId of staged.artifactIds) await this.#artifacts.get(artifactId);

    const manifest = createResumeManifest(staged, current.status, now);
    const artifact = await this.#artifacts.put({
      bytes: JSON.stringify(manifest, null, 2),
      kind: 'review-summary',
      mediaType: 'application/json',
      privacy: 'internal',
      executionContextDigest: executionContextDigest({ schemaVersion: 1, sessionId: staged.id }),
      metadata: {
        reviewType: 'developer-resume-manifest',
        sessionId: staged.id,
        resumeManifestId: manifest.id,
        activeResourceCount: staged.activeResourceKeys.length,
        referencedArtifactCount: staged.artifactIds.length
      },
      now
    });

    const paused = updateDeveloperSession(staged, {
      status: 'PAUSED',
      artifactIds: [...new Set([...staged.artifactIds, artifact.id])].sort()
    }, now);
    await this.#sessions.put(paused);
    return { session: paused, manifest, artifactId: artifact.id };
  }

  async resume(input: {
    sessionId: string;
    resumeManifestArtifactId: string;
    now?: string;
  }): Promise<{ session: DeveloperSession; manifest: DeveloperResumeManifest }> {
    const now = canonicalIso(input.now ?? new Date().toISOString());
    const session = await this.#sessions.get(input.sessionId);
    if (session.status !== 'PAUSED') {
      throw new OperatorError(
        'DEVELOPER_SESSION_RESUME_STATE_INVALID',
        'Only PAUSED Developer Sessions may be resumed.'
      );
    }
    const artifact = await this.#artifacts.read(input.resumeManifestArtifactId);
    if (
      artifact.record.kind !== 'review-summary' ||
      artifact.record.mediaType !== 'application/json' ||
      artifact.record.metadata.reviewType !== 'developer-resume-manifest' ||
      artifact.record.metadata.sessionId !== session.id
    ) {
      throw new OperatorError(
        'DEVELOPER_RESUME_MANIFEST_INVALID',
        'Resume manifest artifact has the wrong immutable class or session binding.'
      );
    }
    let manifest: DeveloperResumeManifest;
    try {
      manifest = normalizeResumeManifest(JSON.parse(artifact.bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('DEVELOPER_RESUME_MANIFEST_INVALID', 'Resume manifest JSON is invalid.');
    }
    if (
      artifact.record.metadata.resumeManifestId !== manifest.id ||
      manifest.sessionId !== session.id
    ) {
      throw new OperatorError(
        'DEVELOPER_RESUME_MANIFEST_INVALID',
        'Resume manifest content does not match artifact metadata.'
      );
    }

    assertSessionMatchesManifest(session, manifest, artifact.record.id);
    for (const artifactId of manifest.artifactIds) await this.#artifacts.get(artifactId);

    const resumed = updateDeveloperSession(session, {
      status: 'ACTIVE',
      resumeSummary:
        'Resumed from immutable manifest ' + manifest.id +
        '; re-observe active resources before the next mutation.'
    }, now);
    await this.#sessions.put(resumed);
    return { session: resumed, manifest };
  }

  async publishExternalReview(input: {
    sessionId: string;
    evidencePackArtifactId?: string;
    resumeManifestArtifactId?: string;
    now?: string;
  }): Promise<{ summary: DeveloperExternalReviewSummary; artifactId: string }> {
    const now = canonicalIso(input.now ?? new Date().toISOString());
    const session = await this.#sessions.get(input.sessionId);
    if (input.evidencePackArtifactId) {
      const pack = await this.#artifacts.get(input.evidencePackArtifactId);
      if (pack.kind !== 'evidence-pack') {
        throw new OperatorError(
          'DEVELOPER_REVIEW_EVIDENCE_INVALID',
          'External review evidencePackArtifactId must reference an Evidence Pack.'
        );
      }
      if (!session.artifactIds.includes(pack.id)) {
        throw new OperatorError(
          'DEVELOPER_REVIEW_EVIDENCE_INVALID',
          'Evidence Pack is not attached to this Developer Session.'
        );
      }
    }
    if (input.resumeManifestArtifactId) {
      const manifestArtifact = await this.#artifacts.get(input.resumeManifestArtifactId);
      if (
        manifestArtifact.kind !== 'review-summary' ||
        manifestArtifact.metadata.reviewType !== 'developer-resume-manifest' ||
        manifestArtifact.metadata.sessionId !== session.id
      ) {
        throw new OperatorError(
          'DEVELOPER_REVIEW_RESUME_INVALID',
          'Resume manifest is not bound to this Developer Session.'
        );
      }
    }

    for (const artifactId of session.artifactIds) await this.#artifacts.get(artifactId);

    const identity = {
      schemaVersion: 1 as const,
      sessionId: session.id,
      status: session.status,
      objective: session.objective,
      acceptanceCriteria: session.acceptanceCriteria,
      constraints: session.constraints,
      ...(session.workspaceGraphId ? { workspaceGraphId: session.workspaceGraphId } : {}),
      ...(session.planRef ? { planRef: session.planRef } : {}),
      activeResourceKeys: session.activeResourceKeys,
      artifactIds: session.artifactIds,
      checkpointIds: session.checkpointIds,
      approvalIds: session.approvalIds,
      ...(input.evidencePackArtifactId ? { evidencePackArtifactId: input.evidencePackArtifactId } : {}),
      ...(input.resumeManifestArtifactId ? { resumeManifestArtifactId: input.resumeManifestArtifactId } : {})
    };
    const summary: DeveloperExternalReviewSummary = {
      ...identity,
      id: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
      createdAt: now
    };
    const artifact = await this.#artifacts.put({
      bytes: JSON.stringify(summary, null, 2),
      kind: 'review-summary',
      mediaType: 'application/json',
      privacy: 'internal',
      executionContextDigest: executionContextDigest({ schemaVersion: 1, sessionId: session.id }),
      metadata: {
        reviewType: 'developer-external-review',
        sessionId: session.id,
        reviewSummaryId: summary.id,
        artifactCount: summary.artifactIds.length,
        acceptanceCriterionCount: summary.acceptanceCriteria.length
      },
      now
    });
    const updated = updateDeveloperSession(session, {
      artifactIds: [...new Set([...session.artifactIds, artifact.id])].sort()
    }, now);
    await this.#sessions.put(updated);
    return { summary, artifactId: artifact.id };
  }
}

export function createResumeManifest(
  sessionInput: DeveloperSession,
  statusBeforePause: string,
  now = new Date().toISOString()
): DeveloperResumeManifest {
  const session = structuredClone(sessionInput);
  const resumeSummary = boundedText(session.resumeSummary, 16_384, 'resumeSummary');
  const createdAt = canonicalIso(now);
  const identity = {
    schemaVersion: 1 as const,
    sessionId: session.id,
    objectiveDigest: digestText(session.objective),
    acceptanceCriteriaDigest: digestValue(session.acceptanceCriteria),
    constraintsDigest: digestValue(session.constraints),
    workspaceRootNodeId: session.workspaceRootNodeId,
    ...(session.workspaceGraphId ? { workspaceGraphId: session.workspaceGraphId } : {}),
    ...(session.planRef ? { planRef: session.planRef } : {}),
    taskIds: [...session.taskIds],
    artifactIds: [...session.artifactIds],
    approvalIds: [...session.approvalIds],
    checkpointIds: [...session.checkpointIds],
    activeResourceKeys: [...session.activeResourceKeys],
    statusBeforePause: boundedText(statusBeforePause, 64, 'statusBeforePause'),
    resumeSummary
  };
  return {
    ...identity,
    id: sha256(Buffer.from(canonicalJson(identity), 'utf8')),
    createdAt
  };
}

function normalizeResumeManifest(input: unknown): DeveloperResumeManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidManifest('Resume manifest must be an object.');
  }
  const raw = input as DeveloperResumeManifest;
  if (raw.schemaVersion !== 1) throw invalidManifest('Resume manifest schemaVersion must be 1.');
  const identity = {
    schemaVersion: 1 as const,
    sessionId: boundedId(raw.sessionId, 'sessionId'),
    objectiveDigest: digest(raw.objectiveDigest, 'objectiveDigest'),
    acceptanceCriteriaDigest: digest(raw.acceptanceCriteriaDigest, 'acceptanceCriteriaDigest'),
    constraintsDigest: digest(raw.constraintsDigest, 'constraintsDigest'),
    workspaceRootNodeId: boundedId(raw.workspaceRootNodeId, 'workspaceRootNodeId'),
    ...(raw.workspaceGraphId ? { workspaceGraphId: digest(raw.workspaceGraphId, 'workspaceGraphId') } : {}),
    ...(raw.planRef ? {
      planRef: {
        taskId: boundedId(raw.planRef.taskId, 'planRef.taskId'),
        revision: boundedRevision(raw.planRef.revision)
      }
    } : {}),
    taskIds: idList(raw.taskIds, 'taskIds'),
    artifactIds: digestList(raw.artifactIds, 'artifactIds'),
    approvalIds: idList(raw.approvalIds, 'approvalIds'),
    checkpointIds: idList(raw.checkpointIds, 'checkpointIds'),
    activeResourceKeys: resourceList(raw.activeResourceKeys),
    statusBeforePause: boundedText(raw.statusBeforePause, 64, 'statusBeforePause'),
    resumeSummary: boundedText(raw.resumeSummary, 16_384, 'resumeSummary')
  };
  const id = digest(raw.id, 'manifest id');
  if (id !== sha256(Buffer.from(canonicalJson(identity), 'utf8'))) {
    throw invalidManifest('Resume manifest id does not match its immutable content.');
  }
  return { ...identity, id, createdAt: canonicalIso(raw.createdAt) };
}

function assertSessionMatchesManifest(
  session: DeveloperSession,
  manifest: DeveloperResumeManifest,
  resumeArtifactId: string
): void {
  const expectedArtifacts = [...new Set([...manifest.artifactIds, resumeArtifactId])].sort();
  const same =
    session.id === manifest.sessionId &&
    digestText(session.objective) === manifest.objectiveDigest &&
    digestValue(session.acceptanceCriteria) === manifest.acceptanceCriteriaDigest &&
    digestValue(session.constraints) === manifest.constraintsDigest &&
    session.workspaceRootNodeId === manifest.workspaceRootNodeId &&
    session.workspaceGraphId === manifest.workspaceGraphId &&
    canonicalJson(session.planRef ?? null) === canonicalJson(manifest.planRef ?? null) &&
    canonicalJson(session.taskIds) === canonicalJson(manifest.taskIds) &&
    canonicalJson(session.artifactIds) === canonicalJson(expectedArtifacts) &&
    canonicalJson(session.approvalIds) === canonicalJson(manifest.approvalIds) &&
    canonicalJson(session.checkpointIds) === canonicalJson(manifest.checkpointIds) &&
    canonicalJson(session.activeResourceKeys) === canonicalJson(manifest.activeResourceKeys) &&
    session.resumeSummary === manifest.resumeSummary;
  if (!same) {
    throw new OperatorError(
      'DEVELOPER_RESUME_STATE_CHANGED',
      'Developer Session changed after the resume manifest was published.'
    );
  }
}

function digestValue(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function digestText(value: string): string {
  return sha256(Buffer.from(value, 'utf8'));
}

function digest(input: unknown, label: string): string {
  const value = String(input ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw invalidManifest(label + ' must be SHA-256.');
  return value;
}

function boundedId(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!/^[A-Za-z0-9._:@/+\-=]{1,512}$/.test(value)) throw invalidManifest(label + ' is invalid.');
  return value;
}

function boundedRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw invalidManifest('plan revision is invalid.');
  return revision;
}

function idList(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 20_000) throw invalidManifest(label + ' is invalid.');
  return [...new Set(input.map((item) => boundedId(item, label)))].sort();
}

function digestList(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > 20_000) throw invalidManifest(label + ' is invalid.');
  return [...new Set(input.map((item) => digest(item, label)))].sort();
}

function resourceList(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 20_000) throw invalidManifest('activeResourceKeys is invalid.');
  const values = input.map((item) => {
    const value = String(item ?? '');
    if (!value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4096) {
      throw invalidManifest('activeResourceKeys contains invalid value.');
    }
    return value;
  });
  return [...new Set(values)].sort();
}

function boundedText(input: unknown, maxBytes: number, label: string): string {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input, 'utf8') > maxBytes) {
    throw new OperatorError('DEVELOPER_SESSION_REVIEW_INVALID', label + ' is invalid.');
  }
  return input;
}

function canonicalIso(input: unknown): string {
  const value = String(input ?? '');
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new OperatorError('DEVELOPER_SESSION_REVIEW_INVALID', 'Timestamp must be canonical ISO.');
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function invalidManifest(message: string): OperatorError {
  return new OperatorError('DEVELOPER_RESUME_MANIFEST_INVALID', message);
}
