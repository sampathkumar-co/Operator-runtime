import { OperatorError } from './errors.ts';
import type { ModelGoalGenerator, ModelTextGeneration } from './bounded-model-goal-inference.ts';

function rejected(code: string, reason: string): never {
  throw new OperatorError(code, reason);
}
function loopbackUrl(endpoint: unknown): URL {
  if (typeof endpoint !== 'string' || endpoint.length > 512 || !endpoint.length) {
    rejected('TASK_MODEL_ENDPOINT_DENIED', 'Local model endpoint must be an explicit bounded URL.');
  }
  let url: URL;
  try { url = new URL(endpoint); }
  catch { return rejected('TASK_MODEL_ENDPOINT_DENIED', 'Local model endpoint URL is malformed.'); }
  if (url.protocol !== 'http:' || url.username || url.password ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/v1/chat/completions' || url.search || url.hash) {
    rejected('TASK_MODEL_ENDPOINT_DENIED',
      'Only a literal loopback OpenAI-compatible chat completion endpoint is permitted.');
  }
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) {
    rejected('TASK_MODEL_ENDPOINT_DENIED', 'Local model endpoint must declare a TCP port.');
  }
  return url;
}
function boundedResult(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    rejected('TASK_MODEL_RESPONSE_INVALID', 'Model response must be a JSON object.');
  }
  const response = value as Record<string, unknown>;
  const choices = response.choices;
  const first = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  const message = first && typeof first === 'object' && !Array.isArray(first)
    ? (first as Record<string, unknown>).message : null;
  const content = message && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>).content : null;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 24 * 1024) {
    rejected('TASK_MODEL_RESPONSE_INVALID', 'Local model must return a bounded JSON response message.');
  }
  return content;
}

/**
 * Local OpenAI-chat-compatible transport for LM Studio, Ollama compatibility
 * servers, or another user-approved literal-loopback service.
 *
 * Does NOT discover models, read credentials, send any request until the
 * calling BoundedModelGoalInference obtains explicit transmission consent and
 * durably reserves spend, nor authorize any resulting action.
 */
export class LoopbackChatModelGoalGenerator implements ModelGoalGenerator {
  readonly #endpoint: URL;
  readonly #fetch: typeof fetch;
  constructor(input: {
    endpoint: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#endpoint = loopbackUrl(input?.endpoint);
    this.#fetch = input.fetchImpl ?? fetch;
    if (typeof this.#fetch !== 'function') {
      rejected('TASK_MODEL_ENDPOINT_DENIED', 'A bounded HTTP fetch transport is required.');
    }
  }

  async generate(input: {
    modelId: string; prompt: string; maxOutputTokens: number; signal: AbortSignal;
  }): Promise<ModelTextGeneration> {
    if (!input || typeof input.modelId !== 'string' || input.modelId.trim() !== input.modelId ||
        input.modelId.length < 1 || input.modelId.length > 128 ||
        typeof input.prompt !== 'string' ||
        Buffer.byteLength(input.prompt, 'utf8') < 1 ||
        Buffer.byteLength(input.prompt, 'utf8') > 16 * 1024 ||
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens < 64 || input.maxOutputTokens > 4096 ||
        !(input.signal instanceof AbortSignal)) {
      rejected('TASK_MODEL_REQUEST_INVALID', 'Local model request exceeded the bounded contract.');
    }
    if (input.signal.aborted) rejected('TASK_MODEL_INFERENCE_ABORTED', 'Request was cancelled before transport.');
    const body = JSON.stringify({
      model: input.modelId,
      messages: [
        { role: 'system', content: 'Return one strict JSON object with goal and successConditions; do not include Markdown or prose. You are proposing only, not executing.' },
        { role: 'user', content: input.prompt }
      ],
      max_tokens: input.maxOutputTokens,
      temperature: 0,
      stream: false
    });
    let res: Response;
    try {
      res = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body, signal: input.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store'
      });
    } catch (error) {
      if (input.signal.aborted) rejected('TASK_MODEL_INFERENCE_ABORTED', 'Model request was cancelled.');
      rejected('TASK_MODEL_TRANSPORT_FAILED',
        'Local model endpoint unavailable or rejected the nonredirecting request.');
    }
    if (!res.ok) rejected('TASK_MODEL_TRANSPORT_FAILED', 'Local model endpoint did not return HTTP success.');
    const declaredLength = res.headers.get('content-length');
    if (declaredLength !== null && (!/^\d{1,8}$/.test(declaredLength) ||
        Number(declaredLength) > 32 * 1024)) {
      rejected('TASK_MODEL_RESPONSE_INVALID', 'Local model response exceeds the bounded byte limit.');
    }
    let json: unknown;
    if (!res.body) rejected('TASK_MODEL_RESPONSE_INVALID', 'Local model returned no response stream.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        if (input.signal.aborted) rejected('TASK_MODEL_INFERENCE_ABORTED', 'Response read was cancelled.');
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 32 * 1024) {
          rejected('TASK_MODEL_RESPONSE_INVALID', 'Local model streamed oversized response.');
        }
        chunks.push(part.value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* no authority granted */ }
      reader.releaseLock();
    }
    if (input.signal.aborted || bytes === 0) {
      rejected('TASK_MODEL_RESPONSE_INVALID', 'Local model response was empty or cancelled.');
    }
    const combined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes);
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)); }
    catch { rejected('TASK_MODEL_RESPONSE_INVALID', 'Model endpoint returned invalid JSON bytes.'); }
    return { text: boundedResult(json) };
  }
}
