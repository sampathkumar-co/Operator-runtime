import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';

const MAX_TIMEOUT_MS = 10 * 60_000;

export interface RelayAgentClientOptions {
  baseUrl: string;
  token: string;
  accountId: string;
  deviceId?: string;
  projectKey?: string;
  waitMs?: number;
}

export class RelayAgentClient {
  #url: URL;
  #token: string;
  #accountId: string;
  #deviceId?: string;
  #projectKey?: string;
  #waitMs: number;

  constructor(options: RelayAgentClientOptions) {
    this.#url = validateLoopbackControlUrl(options.baseUrl);
    if (options.token.length < 32) throw new Error('Relay control token must be at least 32 characters.');
    this.#token = options.token;
    this.#accountId = validUuid(options.accountId, 'OPERATOR_RELAY_ACCOUNT_ID');
    this.#deviceId = options.deviceId ? validUuid(options.deviceId, 'OPERATOR_RELAY_DEVICE_ID') : undefined;
    this.#projectKey = options.projectKey ? validProjectKey(options.projectKey) : undefined;
    const waitMs = options.waitMs ?? MAX_TIMEOUT_MS;
    if (!Number.isInteger(waitMs) || waitMs < 1_000 || waitMs > MAX_TIMEOUT_MS) throw new Error(`Relay wait must be between 1000 and ${MAX_TIMEOUT_MS} ms.`);
    this.#waitMs = waitMs;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`
      },
      body: JSON.stringify({
        accountId: this.#accountId,
        ...(this.#deviceId ? { deviceId: this.#deviceId } : {}),
        ...(this.#projectKey ? { projectKey: this.#projectKey } : {}),
        action,
        waitMs: this.#waitMs
      }),
      signal: AbortSignal.timeout(this.#waitMs + 5_000)
    });
    const body = await response.json() as ActionResult;
    if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean' || !Array.isArray(body.evidence) || typeof body.provider !== 'string') {
      throw new Error(`Relay control returned malformed HTTP ${response.status} response.`);
    }
    return body;
  }
}

function validateLoopbackControlUrl(input: string): URL {
  let base: URL;
  try { base = new URL(input); } catch { throw new Error('OPERATOR_RELAY_CONTROL_URL is invalid.'); }
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host) || base.username || base.password || base.hash) {
    throw new Error('Relay control URL must be credential-free loopback http://.');
  }
  return new URL('/v1/execute', base);
}

function validUuid(value: string, name: string): string {
  const text = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${name} must be a UUID.`);
  return text.toLowerCase();
}

function validProjectKey(value: string): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error('OPERATOR_RELAY_PROJECT_KEY is invalid.');
  return text;
}
