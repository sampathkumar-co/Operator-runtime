import crypto from 'node:crypto';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import {
  validateModelGoalProposal, type ModelGoalProposalRequest,
  type ValidatedModelGoalProposal
} from './model-goal-proposal.ts';

export interface ModelTextGeneration {
  text: string;
}
export interface ModelGoalGenerator {
  /** No credentials or network source are selected by Mecord; caller injects the chosen provider. */
  generate(input: {
    modelId: string;
    prompt: string;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<ModelTextGeneration>;
}
export interface ModelCallBudgetLedger {
  /**
   * Must persist the maximum potential cost and call count BEFORE any provider call.
   * Rejection, uncertainty and restarts must retain the charge until durable reconciliation.
   */
  reserve(input: {
    callId: string; modelId: string; maxOutputTokens: number;
    maxCostMicros: number;
  }): Promise<{ reservationId: string }>;
  /** UNKNOWN_SPEND is not a refund. Finalization failure blocks user-visible success. */
  finalize(input: {
    reservationId: string; callId: string;
    outcome: 'VALIDATED_PROPOSAL' | 'UNKNOWN_SPEND';
  }): Promise<void>;
}
export interface ModelGoalInferenceRequest {
  scope: ModelGoalProposalRequest;
  /** Explicit consent to transmit this minimized scope and objective to the configured model. */
  allowModelTransmission: true;
  signal?: AbortSignal;
}
export interface ModelGoalInferenceResult {
  modelId: string;
  reservationId: string;
  proposal: ValidatedModelGoalProposal;
  executionStarted: false;
}

function refused(code: string, message: string): never {
  throw new OperatorError(code, message);
}
function requiredText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value ||
      value.length > limit || value.includes('\0')) {
    refused('TASK_MODEL_INFERENCE_INVALID', label + ' must be a bounded exact string.');
  }
  return value;
}

/**
 * Consent is a source-time value, not a mutable object retained while a model
 * call is in flight. Read exact, inert array slots once before spend reservation
 * and bind both the outgoing prompt and returned proposal to the same copy.
 */
function exactScopeStrings(input: unknown, max: number, label: string): string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > max || Reflect.ownKeys(input).length !== input.length + 1) {
    refused('TASK_MODEL_INFERENCE_INVALID', label + ' must be a bounded dense array.');
  }
  const copy: string[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(input, String(i));
    if (!desc || !desc.enumerable || !('value' in desc) || typeof desc.value !== 'string') {
      refused('TASK_MODEL_INFERENCE_INVALID', label + ' contains an untrusted entry.');
    }
    copy.push(desc.value);
  }
  return copy;
}

export class BoundedModelGoalInference {
  readonly #generator: ModelGoalGenerator;
  readonly #ledger: ModelCallBudgetLedger;
  readonly #modelId: string;
  readonly #maxOutputTokens: number;
  readonly #maxCostMicros: number;
  readonly #timeoutMs: number;
  #active = false;

  constructor(options: {
    generator: ModelGoalGenerator; ledger: ModelCallBudgetLedger; modelId: string;
    maxOutputTokens?: number; maxCostMicros?: number; timeoutMs?: number;
  }) {
    if (!options || typeof options.generator?.generate !== 'function' ||
        typeof options.ledger?.reserve !== 'function' ||
        typeof options.ledger?.finalize !== 'function') {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Provider and durable reservation ledger are mandatory.');
    }
    this.#generator = options.generator;
    this.#ledger = options.ledger;
    this.#modelId = requiredText(options.modelId, 128, 'modelId');
    this.#maxOutputTokens = options.maxOutputTokens ?? 2048;
    this.#maxCostMicros = options.maxCostMicros ?? 100_000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#maxOutputTokens) || this.#maxOutputTokens < 64 ||
        this.#maxOutputTokens > 4096 ||
        !Number.isSafeInteger(this.#maxCostMicros) || this.#maxCostMicros < 0 ||
        this.#maxCostMicros > 2_000_000 ||
        !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 ||
        this.#timeoutMs > 45_000) {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Inference cost, token or timeout limit is invalid.');
    }
  }

  async propose(request: ModelGoalInferenceRequest): Promise<ModelGoalInferenceResult> {
    if (!request || request.allowModelTransmission !== true) {
      refused('TASK_MODEL_TRANSMISSION_DENIED', 'Explicit model data-transfer approval is required.');
    }
    if (request.signal?.aborted) {
      refused('TASK_MODEL_INFERENCE_ABORTED', 'Model inference was cancelled before reservation.');
    }
    if (this.#active) {
      refused('TASK_MODEL_INFERENCE_BUSY', 'Concurrent inference through one bounded adapter is denied.');
    }

    // The privacy-scoped prompt contains only the stated objective and explicitly
    // authorized roots/origins. Never append secret-bearing observations or file data.
    const suppliedScope = request.scope;
    if (!suppliedScope || typeof suppliedScope !== 'object' || Array.isArray(suppliedScope)) {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Explicit bounded approved resource scope required.');
    }
    const scopeDescriptors = Object.getOwnPropertyDescriptors(suppliedScope);
    for (const key of ['objective', 'approvedRoots', 'approvedBrowserOrigins']) {
      const desc = scopeDescriptors[key];
      if (!desc || !desc.enumerable || !('value' in desc)) {
        refused('TASK_MODEL_INFERENCE_INVALID', 'Model scope must contain inert consent fields.');
      }
    }
    if (Reflect.ownKeys(suppliedScope).some(key =>
        typeof key !== 'string' || !['objective', 'approvedRoots', 'approvedBrowserOrigins'].includes(key))) {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Model scope contains unsupported authority fields.');
    }
    const objective = requiredText(scopeDescriptors.objective!.value, 4096, 'objective');
    const approvedRoots = exactScopeStrings(scopeDescriptors.approvedRoots!.value, 12, 'approvedRoots');
    const approvedBrowserOrigins = exactScopeStrings(scopeDescriptors.approvedBrowserOrigins!.value, 12, 'approvedBrowserOrigins');
    if (approvedRoots.length + approvedBrowserOrigins.length === 0) {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Explicit bounded approved resource scope required.');
    }
    // This copy is never returned to the caller or model provider. A caller
    // mutating its original arrays after the request begins cannot expand
    // preflight authorization after an asynchronous model response.
    const scope: ModelGoalProposalRequest = { objective, approvedRoots, approvedBrowserOrigins };
    for (const root of scope.approvedRoots) {
      if (typeof root !== 'string' || root.length > 4096 || root.includes('\0') ||
          !path.isAbsolute(root)) {
        refused('TASK_MODEL_INFERENCE_INVALID', 'Approved model project roots must be absolute and bounded.');
      }
    }
    for (const origin of scope.approvedBrowserOrigins) {
      if (typeof origin !== 'string' || origin.length > 2048) {
        refused('TASK_MODEL_INFERENCE_INVALID', 'Model browser origins must be bounded.');
      }
      let parsed: URL;
      try { parsed = new URL(origin); }
      catch { refused('TASK_MODEL_INFERENCE_INVALID', 'Model browser origin is invalid.'); }
      if (!['http:', 'https:'].includes(parsed!.protocol) || parsed!.username ||
          parsed!.password || parsed!.origin !== origin || parsed!.pathname !== '/' ||
          parsed!.search || parsed!.hash) {
        refused('TASK_MODEL_INFERENCE_INVALID',
          'Model may see only credential-free exact approved browser origins.');
      }
    }
    const prompt = JSON.stringify({
      instruction: 'Return JSON only: {goal, successConditions}. Allowed typed goals: browser-navigation with url; trusted-project-command with root and commandKind lint/test/build; project-quality-gate with root, checks, requireAll:true; or semantic-workflow with 2-4 allowed atomic steps. Propose only within the given scope. Never claim actions were executed or grant permissions.',
      objective: scope.objective,
      approvedBrowserOrigins: scope.approvedBrowserOrigins,
      approvedProjectRoots: scope.approvedRoots
    });
    if (Buffer.byteLength(prompt, 'utf8') > 16 * 1024) {
      refused('TASK_MODEL_INFERENCE_INVALID', 'Minimized model prompt exceeds safe size.');
    }

    this.#active = true;
    const callId = crypto.randomUUID();
    try {
      const reservation = await this.#ledger.reserve({
        callId, modelId: this.#modelId,
        maxOutputTokens: this.#maxOutputTokens,
        maxCostMicros: this.#maxCostMicros
      });
      const reservationId = requiredText(reservation?.reservationId, 256, 'reservationId');
      let proposal: ValidatedModelGoalProposal | undefined;
      let status: 'VALIDATED_PROPOSAL' | 'UNKNOWN_SPEND' = 'UNKNOWN_SPEND';
      try {
        if (request.signal?.aborted) {
          refused('TASK_MODEL_INFERENCE_ABORTED', 'Model inference cancelled before provider call.');
        }
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        request.signal?.addEventListener('abort', onAbort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timed = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new OperatorError('TASK_MODEL_INFERENCE_TIMEOUT',
                'Model exceeded its bounded inference deadline.'));
              controller.abort();
            }, this.#timeoutMs);
            controller.signal.addEventListener('abort', () => reject(new OperatorError(
              'TASK_MODEL_INFERENCE_ABORTED', 'Model inference was cancelled.'
            )), { once: true });
          });
          // A provider that ignores abort cannot return a late authorization.
          const response = await Promise.race([
            Promise.resolve().then(() => this.#generator.generate({
              modelId: this.#modelId, prompt,
              maxOutputTokens: this.#maxOutputTokens,
              signal: controller.signal
            })),
            timed
          ]);
          if (controller.signal.aborted || request.signal?.aborted) {
            refused('TASK_MODEL_INFERENCE_ABORTED', 'Late or cancelled model proposal discarded.');
          }
          if (typeof response?.text !== 'string' ||
              Buffer.byteLength(response.text, 'utf8') > 24 * 1024) {
            refused('TASK_MODEL_INFERENCE_INVALID', 'Model output must be bounded JSON text.');
          }
          let parsed: unknown;
          try { parsed = JSON.parse(response.text); }
          catch { refused('TASK_MODEL_INFERENCE_INVALID', 'Model output must be strict JSON.'); }
          proposal = validateModelGoalProposal(parsed, scope);
          status = 'VALIDATED_PROPOSAL';
        } finally {
          if (timer) clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
        }
      } finally {
        // Never release the bounded reservation by guessing model usage. Failure
        // to finalize is a hard failure even after valid JSON was received.
        await this.#ledger.finalize({ reservationId, callId, outcome: status });
      }
      if (!proposal) refused('TASK_MODEL_INFERENCE_INVALID', 'No validated model proposal.');
      return { modelId: this.#modelId, reservationId, proposal, executionStarted: false };
    } finally {
      this.#active = false;
    }
  }
}
