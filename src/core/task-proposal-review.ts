import crypto from 'node:crypto';
import { OperatorError } from './errors.ts';
import type { SemanticTaskGoal } from './task-orchestrator-contracts.ts';

export interface ReviewedTaskProposal {
  goal: SemanticTaskGoal;
  successConditions: string[];
}

interface PendingProposalReview {
  principal: string;
  objective: string;
  proposal: ReviewedTaskProposal;
  scope: string[];
  digest: string;
  expiresAtMs: number;
}

function reject(code: string, message: string): never {
  throw new OperatorError(code, message);
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value ||
      value.length > max || value.includes('\0')) {
    reject('TASK_PROPOSAL_REVIEW_INVALID', label + ' is missing or invalid.');
  }
  return value;
}

function canonicalScope(scope: unknown): string[] {
  if (!Array.isArray(scope) || Object.getPrototypeOf(scope) !== Array.prototype ||
      scope.length < 1 || scope.length > 32 ||
      Reflect.ownKeys(scope).length !== scope.length + 1) {
    reject('TASK_PROPOSAL_SCOPE_DENIED', 'A review requires a dense inert authorized scope.');
  }
  for (let i = 0; i < scope.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(scope, String(i));
    if (!slot || !slot.enumerable || !('value' in slot) || typeof slot.value !== 'string') {
      reject('TASK_PROPOSAL_SCOPE_DENIED', 'Review scope contains a missing or executable entry.');
    }
  }
  const result: string[] = [];
  for (const value of scope) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value ||
        value.length > 4096 || value.includes('\0')) {
      reject('TASK_PROPOSAL_SCOPE_DENIED', 'Review scope contains an invalid resource.');
    }
    result.push(value);
  }
  return [...new Set(result)].sort();
}

/**
 * structuredClone reads accessor values, while JSON.stringify silently drops
 * undefined object fields and fills array holes with null. Neither behavior
 * belongs in a one-use approval digest. Inspect inert own descriptors first.
 */
function validateInertReviewJson(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  function walk(node: unknown, depth: number): void {
    if (++nodes > 4096 || depth > 16) {
      reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review JSON exceeds bounded depth or nodes.');
    }
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number' && Number.isFinite(node)) return;
    if (typeof node !== 'object' || node === null || ancestors.has(node)) {
      reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review requires finite inert JSON data.');
    }
    const isArray = Array.isArray(node);
    const proto = Object.getPrototypeOf(node);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review data must be plain objects and arrays.');
    }
    const own = Reflect.ownKeys(node);
    if (own.some(key => typeof key !== 'string') ||
        (isArray && (node.length > 4096 || own.length !== node.length + 1))) {
      reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review data contains unsupported fields or sparse arrays.');
    }
    ancestors.add(node);
    for (const key of own) {
      if (typeof key !== 'string') {
        reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review data cannot contain symbol fields.');
      }
      if (isArray && key === 'length') continue;
      if (isArray && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length)) {
        reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review array contains an unknown property.');
      }
      const desc = Object.getOwnPropertyDescriptor(node, key);
      if (!desc || !desc.enumerable || !('value' in desc)) {
        reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review data cannot contain executable or hidden fields.');
      }
      walk(desc.value, depth + 1);
    }
    ancestors.delete(node);
  }
  walk(value, 0);
}

function snapshotProposal(value: unknown): ReviewedTaskProposal {
  validateInertReviewJson(value);
  let proposal: ReviewedTaskProposal;
  try { proposal = structuredClone(value) as ReviewedTaskProposal; }
  catch { return reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review proposal cannot be safely copied.'); }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) ||
      !proposal.goal || typeof proposal.goal !== 'object' ||
      Array.isArray(proposal.goal) || !Array.isArray(proposal.successConditions) ||
      proposal.successConditions.length < 1 || proposal.successConditions.length > 5 ||
      proposal.successConditions.some(condition => typeof condition !== 'string' ||
        !condition.trim() || condition.trim() !== condition ||
        condition.length > 512 || condition.includes('\0'))) {
    reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review requires a previously validated typed proposal.');
  }
  let serialized: string;
  try { serialized = JSON.stringify(proposal); }
  catch { return reject('TASK_PROPOSAL_REVIEW_INVALID', 'Review proposal must be serializable JSON.'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 24 * 1024) {
    reject('TASK_PROPOSAL_REVIEW_INVALID', 'Reviewed proposal exceeds the bounded size.');
  }
  // This is an immutable review snapshot, NOT a semantic validator or an execution grant.
  return proposal;
}

/**
 * Short-lived one-use confirmation of a previously validated model proposal.
 * Provider authorization and task execution must run through the separate kernel.
 * The registry does not persist, execute actions or contact model providers.
 */
export class TaskProposalReviewRegistry {
  readonly #pending = new Map<string, PendingProposalReview>();
  readonly #now: () => number;
  readonly #lifetimeMs: number;
  readonly #limit: number;

  constructor(options: { now?: () => number; lifetimeMs?: number; limit?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#lifetimeMs = options.lifetimeMs ?? 120_000;
    this.#limit = options.limit ?? 64;
    if (!Number.isSafeInteger(this.#lifetimeMs) || this.#lifetimeMs < 1 ||
        this.#lifetimeMs > 300_000 || !Number.isSafeInteger(this.#limit) ||
        this.#limit < 1 || this.#limit > 512) {
      reject('TASK_PROPOSAL_REVIEW_CONFIG_INVALID', 'Invalid proposal review retention settings.');
    }
  }

  issue(input: {
    principal: string; objective: string; proposal: ReviewedTaskProposal; scope: string[];
  }): { proposalId: string; proposalDigest: string; expiresAt: string } {
    const now = this.#clock();
    this.#prune(now);
    if (this.#pending.size >= this.#limit) {
      reject('TASK_PROPOSAL_REVIEW_CAPACITY', 'Too many pending proposal reviews.');
    }
    const principal = boundedText(input.principal, 512, 'principal');
    const objective = boundedText(input.objective, 4096, 'objective');
    const scope = canonicalScope(input.scope);
    const proposal = snapshotProposal(input.proposal);
    const proposalId = crypto.randomUUID();
    const digest = crypto.createHash('sha256').update(JSON.stringify({
      proposalId, principal, objective, proposal, scope
    })).digest('hex');
    const expiresAtMs = now + this.#lifetimeMs;
    this.#pending.set(proposalId, { principal, objective, proposal, scope, digest, expiresAtMs });
    return { proposalId, proposalDigest: digest, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(input: {
    proposalId: string; proposalDigest: string; principal: string;
    currentScopeFor: (proposal: ReviewedTaskProposal) => string[] | null;
  }): { objective: string; proposal: ReviewedTaskProposal; scope: string[]; requestId: string } {
    const now = this.#clock();
    this.#prune(now);
    const record = this.#pending.get(input.proposalId);
    if (!record || record.expiresAtMs <= now || record.principal !== input.principal ||
        typeof input.proposalDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(input.proposalDigest) ||
        !crypto.timingSafeEqual(Buffer.from(record.digest, 'hex'), Buffer.from(input.proposalDigest, 'hex'))) {
      reject('TASK_PROPOSAL_REVIEW_INVALID', 'Proposal review missing, expired or mismatched.');
    }

    // Burn before invoking authority callback. Callback reentrancy, thrown errors
    // or failed submission must never permit a second confirmation.
    this.#pending.delete(input.proposalId);
    const current = input.currentScopeFor(snapshotProposal(record.proposal));
    if (current === null || JSON.stringify(canonicalScope(current)) !== JSON.stringify(record.scope)) {
      reject('TASK_PROPOSAL_SCOPE_DENIED', 'Proposal permissions changed after review.');
    }
    return {
      objective: record.objective,
      proposal: snapshotProposal(record.proposal),
      scope: [...record.scope],
      requestId: input.proposalId
    };
  }

  clear(): void { this.#pending.clear(); }

  #clock(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now + this.#lifetimeMs > Number.MAX_SAFE_INTEGER) {
      reject('TASK_PROPOSAL_REVIEW_CONFIG_INVALID', 'Review clock has an invalid value.');
    }
    return now;
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#pending) {
      if (entry.expiresAtMs <= now) this.#pending.delete(id);
    }
  }
}
