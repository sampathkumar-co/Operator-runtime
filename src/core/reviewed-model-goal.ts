import path from 'node:path';
import { OperatorError } from './errors.ts';
import {
  validateModelGoalProposal, type ModelGoalProposalRequest, type ValidatedModelGoalProposal
} from './model-goal-proposal.ts';
import { TaskProposalReviewRegistry, type ReviewedTaskProposal } from './task-proposal-review.ts';
import type { SubmitTaskOptions } from './task-orchestrator-contracts.ts';

function scopeFor(request: ModelGoalProposalRequest): string[] {
  return [
    ...request.approvedRoots.map(root => 'project:' + path.resolve(root)),
    ...request.approvedBrowserOrigins.map(origin => 'browser:' + new URL(origin).origin)
  ].sort();
}

/**
 * Model output -> bounded typed proposal -> explicit one-use review -> task
 * submission *options*. This creates no task and dispatches no action.
 * The caller owns authentication, choice of scope, explicit user confirmation,
 * current permission refresh and final kernel authorization.
 */
export class ReviewedModelGoalBridge {
  readonly #registry: TaskProposalReviewRegistry;

  constructor(registry = new TaskProposalReviewRegistry()) {
    this.#registry = registry;
  }

  propose(input: {
    principal: string;
    request: ModelGoalProposalRequest;
    modelOutput: unknown;
  }): { proposalId: string; proposalDigest: string; expiresAt: string;
      proposal: ValidatedModelGoalProposal; executionStarted: false } {
    // No issued receipt for invalid/invented model scope or target.
    const validated = validateModelGoalProposal(input.modelOutput, input.request);
    const review = this.#registry.issue({
      principal: input.principal, objective: input.request.objective,
      proposal: validated, scope: scopeFor(input.request)
    });
    return { ...review, proposal: validated, executionStarted: false };
  }

  confirm(input: {
    proposalId: string;
    proposalDigest: string;
    principal: string;
    currentApprovedScopeFor: (proposal: ReviewedTaskProposal) => ModelGoalProposalRequest | null;
  }): SubmitTaskOptions {
    const receipt = this.#registry.consume({
      proposalId: input.proposalId, proposalDigest: input.proposalDigest,
      principal: input.principal,
      currentScopeFor: proposal => {
        const current = input.currentApprovedScopeFor(proposal);
        if (!current) return null;
        try {
          const validated = validateModelGoalProposal(proposal, current);
          if (JSON.stringify(validated) !== JSON.stringify(proposal)) return null;
          return scopeFor(current);
        } catch {
          // An approved root/origin revoked or a goal transformed by a different
          // configuration invalidates this one-use review without dispatch.
          return null;
        }
      }
    });
    if (!receipt.proposal || !receipt.scope.length) {
      throw new OperatorError('TASK_PROPOSAL_REVIEW_INVALID', 'Invalid reviewed proposal receipt.');
    }
    // Intent and provider authority are NOT created here. Existing task/kernel
    // authorization still checks each action, target and potential side effect.
    return {
      requestId: receipt.requestId,
      objective: receipt.objective,
      authorizedScope: [...receipt.scope],
      successConditions: [...receipt.proposal.successConditions],
      goal: structuredClone(receipt.proposal.goal)
    };
  }

  clear(): void { this.#registry.clear(); }
}
