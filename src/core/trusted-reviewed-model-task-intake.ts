import { OperatorError } from './errors.ts';
import type { ModelGoalProposalRequest, ValidatedModelGoalProposal } from './model-goal-proposal.ts';
import type { SubmitTaskOptions } from './task-orchestrator-contracts.ts';
import { ReviewedModelGoalBridge } from './reviewed-model-goal.ts';
import type { BoundedModelGoalInference } from './bounded-model-goal-inference.ts';

type Principal = string;
export interface TrustedModelTaskReview {
  principal: Principal;
  proposalId: string;
  proposalDigest: string;
  reviewProof: unknown;
  /** Optional Stop/cancellation fence owned by the trusted caller, never user JSON. */
  signal?: AbortSignal;
}
export interface ModelTaskIntakeAuthority {
  /**
   * Must be supplied by the trusted authenticated runtime, not user JSON.
   * Null means no current permission for the exact requested roots/origins.
   */
  currentApprovedScope(principal: Principal): Promise<ModelGoalProposalRequest | null>;
  /**
   * Independent native owner/session confirmation. Browser login or an
   * arbitrary boolean in user-supplied JSON must not grant review authority.
   */
  verifyTrustedReview(input: TrustedModelTaskReview): Promise<boolean>;
  /**
   * Canonical runtime task submitter. Must recheck real root/permission/intent
   * and run each dispatched action through the original kernel; this API
   * cannot execute or grant authority itself.
   */
  submitReviewedTask(options: SubmitTaskOptions): Promise<{ id: string; executionStarted: false }>;
}
export interface ReviewedModelTaskDraft {
  proposalId: string;
  proposalDigest: string;
  expiresAt: string;
  proposal: ValidatedModelGoalProposal;
  executionStarted: false;
}
export interface SubmittedReviewedModelTask {
  taskId: string;
  executionStarted: false;
}

function denied(code: string, detail: string): never { throw new OperatorError(code, detail); }
function boundedPrincipal(principal: unknown): asserts principal is string {
  if (typeof principal !== 'string' || principal.length < 1 ||
      principal.length > 512 || principal.trim() !== principal ||
      /[\r\n\0]/.test(principal)) {
    denied('TASK_MODEL_INTAKE_AUTH_INVALID', 'An authenticated bounded principal is mandatory.');
  }
}
function normalizedScope(value: ModelGoalProposalRequest): string {
  if (!value || !Array.isArray(value.approvedRoots) ||
      !Array.isArray(value.approvedBrowserOrigins) ||
      typeof value.objective !== 'string' || !value.objective.trim()) {
    denied('TASK_MODEL_INTAKE_SCOPE_DENIED', 'Current approved model request is invalid.');
  }
  return JSON.stringify({
    objective: value.objective,
    roots: [...value.approvedRoots].sort(),
    browserOrigins: [...value.approvedBrowserOrigins].sort()
  });
}

/**
 * Explicit, non-networking two-stage proposal / native-review / submission
 * adapter. Does not install an inference backend or open a public HTTP route.
 * All authentication, reviewer proof and final task authority are mandatory
 * callbacks from a trusted runtime. No default or self-claimed approval.
 */
export class TrustedReviewedModelTaskIntake {
  readonly #model: BoundedModelGoalInference;
  readonly #review = new ReviewedModelGoalBridge();
  readonly #authority: ModelTaskIntakeAuthority;

  constructor(input: { model: BoundedModelGoalInference; authority: ModelTaskIntakeAuthority }) {
    if (!input || typeof input.model?.propose !== 'function' ||
        typeof input.authority?.currentApprovedScope !== 'function' ||
        typeof input.authority?.verifyTrustedReview !== 'function' ||
        typeof input.authority?.submitReviewedTask !== 'function') {
      denied('TASK_MODEL_INTAKE_AUTH_INVALID',
        'A bounded model, authenticated resource authority, native reviewer and canonical task submitter are required.');
    }
    this.#model = input.model;
    this.#authority = input.authority;
  }

  async propose(input: {
    principal: Principal;
    request: ModelGoalProposalRequest;
    allowModelTransmission: true;
    signal?: AbortSignal;
  }): Promise<ReviewedModelTaskDraft> {
    boundedPrincipal(input?.principal);
    if (input.allowModelTransmission !== true) {
      denied('TASK_MODEL_TRANSMISSION_DENIED', 'No model transmission without explicit consent.');
    }
    const current = await this.#authority.currentApprovedScope(input.principal);
    if (!current || normalizedScope(current) !== normalizedScope(input.request)) {
      denied('TASK_MODEL_INTAKE_SCOPE_DENIED',
        'Model may only observe exactly the current explicitly approved objective and resources.');
    }
    const response = await this.#model.propose({
      scope: input.request, allowModelTransmission: true, signal: input.signal
    });
    // A long inference may finish after Stop, scope revocation, or intent replacement.
    // Discard its valid JSON rather than issuing a review against stale rights.
    const refreshed = await this.#authority.currentApprovedScope(input.principal);
    if (!refreshed || normalizedScope(refreshed) !== normalizedScope(input.request)) {
      denied('TASK_MODEL_INTAKE_SCOPE_DENIED',
        'Approved model objective or resource scope changed while inference was running.');
    }
    const issued = this.#review.propose({
      principal: input.principal,
      request: input.request,
      modelOutput: response.proposal
    });
    return {
      proposalId: issued.proposalId,
      proposalDigest: issued.proposalDigest,
      expiresAt: issued.expiresAt,
      proposal: issued.proposal,
      executionStarted: false
    };
  }

  async confirm(input: TrustedModelTaskReview): Promise<SubmittedReviewedModelTask> {
    boundedPrincipal(input?.principal);
    if (typeof input.proposalId !== 'string' ||
        typeof input.proposalDigest !== 'string' || input.reviewProof === undefined ||
        !/^[0-9a-f-]{36}$/i.test(input.proposalId) ||
        !/^[0-9a-f]{64}$/i.test(input.proposalDigest)) {
      denied('TASK_MODEL_REVIEW_INVALID', 'An exact pending review challenge and trusted review proof are required.');
    }
    if (input.signal?.aborted) denied('TASK_MODEL_REVIEW_DENIED', 'Model task review was stopped.');
    if (!(await this.#authority.verifyTrustedReview({
      principal: input.principal,
      proposalId: input.proposalId,
      proposalDigest: input.proposalDigest,
      reviewProof: input.reviewProof
    }))) {
      denied('TASK_MODEL_REVIEW_DENIED', 'Independent native owner/session review was denied or expired.');
    }
    // An asynchronous native reviewer can return after Stop. It must not
    // promote an expired confirmation into the canonical task queue.
    if (input.signal?.aborted) denied('TASK_MODEL_REVIEW_DENIED', 'Model task review was stopped.');
    const current = await this.#authority.currentApprovedScope(input.principal);
    if (input.signal?.aborted) denied('TASK_MODEL_REVIEW_DENIED', 'Model task review was stopped.');
    const options = this.#review.confirm({
      principal: input.principal,
      proposalId: input.proposalId,
      proposalDigest: input.proposalDigest,
      currentApprovedScopeFor: () => current
    });
    // Stop after one-use consumption intentionally burns the confirmation.
    // Never retry a potentially submitted task following ambiguous outcomes.
    if (input.signal?.aborted) denied('TASK_MODEL_REVIEW_DENIED', 'Model task review was stopped.');
    // Receipt was consumed BEFORE submitting, including reentrant calls.
    // A failed/uncertain submit remains failed; confirmation is not replayed.
    const submitted = await this.#authority.submitReviewedTask(options);
    if (!submitted || typeof submitted.id !== 'string' || !submitted.id.trim() ||
        submitted.executionStarted !== false) {
      denied('TASK_MODEL_SUBMIT_NOT_CONFIRMED',
        'Canonical task store did not confirm a persisted task identity.');
    }
    return { taskId: submitted.id, executionStarted: false };
  }

  clear(): void { this.#review.clear(); }
}
