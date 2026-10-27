import { OperatorError } from './errors.ts';
import type {
  ModelGoalGenerator, ModelTextGeneration
} from './bounded-model-goal-inference.ts';

const OLLAMA_LOOPBACK_GENERATE = 'http://127.0.0.1:11434/api/generate';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_MODEL_TEXT_BYTES = 32 * 1024;

function reject(code: string, message: string): never {
  throw new OperatorError(code, message);
}

export interface LoopbackModelGenerateRequest {
  modelId: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

/**
 * Optional, local-only implementation of the canonical ModelGoalGenerator
 * dependency. It is not installed, configured or automatically invoked by the
 * runtime. Consent, durable budget reservation, bounded inference, typed goal
 * validation, owner review and task authorization remain mandatory upstream.
 *
 * The endpoint is a fixed loopback literal. No credentials, arbitrary URLs,
 * redirects, MCP tool definitions or external account context are supported.
 */
export class LoopbackOllamaModelGoalGenerator implements ModelGoalGenerator {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = options.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(this.#timeoutMs) ||
        this.#timeoutMs < 1 || this.#timeoutMs > 12_000 ||
        typeof this.#fetch !== 'function') {
      reject('TASK_LOCAL_MODEL_CONFIG_INVALID',
        'Local model transport and bounded timeout must be explicitly valid.');
    }
  }

  async generate(input: LoopbackModelGenerateRequest): Promise<ModelTextGeneration> {
    if (!input || typeof input.modelId !== 'string' ||
        !MODEL_ID.test(input.modelId) ||
        typeof input.prompt !== 'string' || !input.prompt.trim() ||
        Buffer.byteLength(input.prompt, 'utf8') > 16 * 1024 ||
        input.prompt.includes('\0') ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 64 || input.maxOutputTokens > 4096 ||
        !input.signal || typeof input.signal.aborted !== 'boolean' ||
        typeof input.signal.addEventListener !== 'function') {
      reject('TASK_LOCAL_MODEL_CONFIG_INVALID',
        'Local model request requires a bounded model, prompt, tokens and cancellation signal.');
    }
    // Pre-aborted signal must fail before constructing cancellation promises.
    // Otherwise an early reject could escape Promise.race as an unhandled one.
    if (input.signal.aborted) {
      reject('TASK_LOCAL_MODEL_ABORTED', 'Local model request was cancelled before transmission.');
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const timedOut = new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => {
        controller.abort();
        rejectTimeout(new OperatorError('TASK_LOCAL_MODEL_TIMEOUT',
          'Local model generation exceeded its fixed request deadline.'));
      }, this.#timeoutMs);
    });
    const cancelled = new Promise<never>((_, rejectCancelled) => {
      onAbort = () => {
        controller.abort();
        rejectCancelled(new OperatorError('TASK_LOCAL_MODEL_ABORTED',
          'Local model request was cancelled.'));
      };
      input.signal.addEventListener('abort', onAbort!, { once: true });
      // Covers a racing cancellation between the earlier check and listener.
      if (input.signal.aborted) onAbort!();
    });

    try {
      return await Promise.race([
        this.#request(input, controller.signal), timedOut, cancelled
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) input.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  async #request(input: LoopbackModelGenerateRequest, signal: AbortSignal): Promise<ModelTextGeneration> {
    try {
      const response = await this.#fetch(OLLAMA_LOOPBACK_GENERATE, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_predict: input.maxOutputTokens }
        })
      });
      if (!response.ok || response.redirected) {
        reject('TASK_LOCAL_MODEL_UNAVAILABLE', 'Local loopback model did not return an approved response.');
      }
      const claimed = response.headers.get('content-length');
      if (claimed !== null && (!/^[0-9]+$/.test(claimed) ||
          Number(claimed) > MAX_HTTP_BODY_BYTES)) {
        reject('TASK_LOCAL_MODEL_OVERSIZE', 'Local model envelope exceeded its size bound.');
      }
      if (!response.body) {
        reject('TASK_LOCAL_MODEL_UNAVAILABLE', 'Local model returned no response body.');
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_HTTP_BODY_BYTES) {
            reject('TASK_LOCAL_MODEL_OVERSIZE', 'Local model streamed an oversized response.');
          }
          chunks.push(value);
        }
      } finally {
        // A hostile transport must not stall the size/deadline failure path.
        void reader.cancel().catch(() => undefined);
      }

      let envelope: unknown;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reject('TASK_LOCAL_MODEL_INVALID', 'Local model response was not valid JSON.'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        reject('TASK_LOCAL_MODEL_INVALID', 'Local model returned an invalid JSON envelope.');
      }
      const modelText = (envelope as { response?: unknown }).response;
      if (typeof modelText !== 'string' || !modelText.trim() ||
          Buffer.byteLength(modelText, 'utf8') > MAX_MODEL_TEXT_BYTES) {
        reject('TASK_LOCAL_MODEL_INVALID', 'Local model response text was invalid or oversized.');
      }
      return { text: modelText };
    } catch (error) {
      if (error instanceof OperatorError) throw error;
      reject('TASK_LOCAL_MODEL_UNAVAILABLE',
        'Local model request failed without exposing any transport or secret details.');
    }
  }
}
