import path from 'node:path';
import { OperatorError } from './errors.ts';
import {
  validateModelGoalProposal, type ModelGoalProposalRequest, type ValidatedModelGoalProposal
} from './model-goal-proposal.ts';
import { TaskProposalReviewRegistry, type ReviewedTaskProposal } from './task-proposal-review.ts';
import type { SubmitTaskOptions } from './task-orchestrator-contracts.ts';

/**
 * A request object can expose getters that return different permission sets
 * on successive reads. Snapshot exact inert own data before validation and
 * reuse the same copy for the issued one-use review digest.
 */
function snapshotReviewScope(input: ModelGoalProposalRequest): ModelGoalProposalRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new OperatorError('TASK_PROPOSAL_SCOPE_DENIED', 'Review requires an inert scope object.');
  }
  const keys = ['objective', 'approvedRoots', 'approvedBrowserOrigins'] as const;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(descriptors, key) ||
        !descriptors[key]?.enumerable || !('value' in descriptors[key]!))) {
    throw new OperatorError('TASK_PROPOSAL_SCOPE_DENIED', 'Review scope contains missing or executable permission fields.');
  }
  const copied = (key: 'approvedRoots' | 'approvedBrowserOrigins'): string[] => {
    const value: unknown = descriptors[key]!.value;
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 12 || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new OperatorError('TASK_PROPOSAL_SCOPE_DENIED', 'Review scope resources must be exact bounded lists.');
    }
    const result: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const slot = Object.getOwnPropertyDescriptor(value, String(i));
      if (!slot || !slot.enumerable || !('value' in slot) || typeof slot.value !== 'string') {
        throw new OperatorError('TASK_PROPOSAL_SCOPE_DENIED', 'Review scope contains untrusted resource entries.');
      }
      result.push(slot.value);
    }
    return result;
  };
  return {
    objective: descriptors.objective!.value as string,
    approvedRoots: copied('approvedRoots'),
    approvedBrowserOrigins: copied('approvedBrowserOrigins')
  };
}

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
    const scopeSnapshot = snapshotReviewScope(input.request);
    const validated = validateModelGoalProposal(input.modelOutput, scopeSnapshot);
    const review = this.#registry.issue({
      principal: input.principal, objective: scopeSnapshot.objective,
      proposal: validated, scope: scopeFor(scopeSnapshot)
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
          // Confirmation must bind validation and the one-use receipt to the
          // same exact permission snapshot. Do not read caller-owned getters
          // or arrays again between checking and constructing authority.
          const currentSnapshot = snapshotReviewScope(current);
          const validated = validateModelGoalProposal(proposal, currentSnapshot);
          if (JSON.stringify(validated) !== JSON.stringify(proposal)) return null;
          return scopeFor(currentSnapshot);
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
