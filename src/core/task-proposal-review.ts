import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { TaskGoalProposal } from './task-goal-interpreter.ts';

type ReviewedProposal = {
  id: string;
  digest: string;
  principal: string;
  objective: string;
  proposal: TaskGoalProposal;
  scope: string[];
  expiresAtMs: number;
};

function rejected(code: string, message: string): never {
  throw new OperatorError(code, message);
}
function canonicalScope(scope: string[]): string[] {
  if (!Array.isArray(scope) || scope.length < 1 || scope.length > 32 ||
      scope.some(value => typeof value !== 'string' || !value || value.length > 4096)) {
    rejected('TASK_PROPOSAL_SCOPE_DENIED', 'Reviewed proposal requires a bounded authorized scope.');
  }
  return [...new Set(scope)].sort();
}

/**
 * A short-lived, session-local review receipt. This is NOT an execution
 * approval: it allows only one explicit task creation with the exact contract
 * returned by the model proposal endpoint. Provider approvals remain separate.
 *
 * Intentionally ephemeral: restart invalidates all pending reviews rather than
 * risking an out-of-date permission/grant restoration.
 */
export class TaskProposalReviewRegistry {
  readonly #records = new Map<string, ReviewedProposal>();
  readonly #now: () => number;
  readonly #lifetimeMs: number;
  readonly #limit: number;

  constructor(options: { now?: () => number; lifetimeMs?: number; limit?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#lifetimeMs = options.lifetimeMs ?? 120_000;
    this.#limit = options.limit ?? 64;
    if (!Number.isSafeInteger(this.#lifetimeMs) || this.#lifetimeMs < 1 || this.#lifetimeMs > 300_000 ||
        !Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 512) {
      rejected('TASK_PROPOSAL_REVIEW_CONFIG_INVALID', 'Reviewed proposal registry limits are invalid.');
    }
  }

  issue(input: {
    principal: string; objective: string; proposal: TaskGoalProposal; scope: string[];
  }): { proposalId: string; proposalDigest: string; expiresAt: string } {
    const now = this.#now();
    this.#prune(now);
    if (this.#records.size >= this.#limit) {
      rejected('TASK_PROPOSAL_REVIEW_CAPACITY', 'Too many outstanding AI proposal reviews.');
    }
    if (!input.principal || input.principal.length > 512 ||
        !input.objective || input.objective.length > 4096) {
      rejected('TASK_PROPOSAL_REVIEW_INVALID', 'Reviewed proposal identity or objective is invalid.');
    }
    const scope = canonicalScope(input.scope);
    const proposal = structuredClone(input.proposal);
    const id = crypto.randomUUID();
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      id, principal: input.principal, objective: input.objective, proposal, scope
    })).digest('hex');
    const expiresAtMs = now + this.#lifetimeMs;
    this.#records.set(id, {
      id, digest, principal: input.principal, objective: input.objective,
      proposal, scope, expiresAtMs
    });
    return { proposalId: id, proposalDigest: digest, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(input: {
    proposalId: string; proposalDigest: string; principal: string; currentScope: string[];
  }): { objective: string; proposal: TaskGoalProposal; scope: string[]; requestId: string } {
    const now = this.#now();
    this.#prune(now);
    const review = this.#records.get(input.proposalId);
    if (!review || review.expiresAtMs <= now || review.principal !== input.principal ||
        !/^[a-f0-9]{64}$/.test(input.proposalDigest) ||
        !crypto.timingSafeEqual(Buffer.from(review.digest, 'hex'), Buffer.from(input.proposalDigest, 'hex'))) {
      rejected('TASK_PROPOSAL_REVIEW_INVALID', 'AI proposal review is missing, expired, mismatched, or already consumed.');
    }
    const scope = canonicalScope(input.currentScope);
    if (JSON.stringify(scope) !== JSON.stringify(review.scope)) {
      rejected('TASK_PROPOSAL_SCOPE_DENIED', 'Reviewed plan permissions changed and must be reviewed again.');
    }
    // Burn before any asynchronous submission. A repeated confirm cannot
    // create or dispatch another task, even if the first submit fails.
    this.#records.delete(input.proposalId);
    return {
      objective: review.objective,
      proposal: structuredClone(review.proposal),
      scope: [...review.scope],
      requestId: review.id
    };
  }

  clear(): void { this.#records.clear(); }

  #prune(now: number): void {
    for (const [id, record] of this.#records) {
      if (record.expiresAtMs <= now) this.#records.delete(id);
    }
  }
}
