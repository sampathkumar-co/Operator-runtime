import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';
import { RelayAgentClient } from './relay-agent-client.ts';

type Executor = { execute(action: ActionRequest): Promise<ActionResult> };

export class LocalAgentClient {
  #executor: Executor;

  constructor(baseUrl: string, token: string) {
    const mode = (process.env.OPERATOR_EXECUTION_MODE ?? 'local').trim().toLowerCase();
    if (mode === 'local') {
      this.#executor = new DirectLocalAgentClient(baseUrl, token);
      return;
    }
    if (mode !== 'relay') throw new Error('OPERATOR_EXECUTION_MODE must be local or relay.');

    const relayToken = process.env.OPERATOR_RELAY_CONTROL_TOKEN?.trim() || token;
    const accountId = process.env.OPERATOR_RELAY_ACCOUNT_ID?.trim();
    if (!accountId) throw new Error('OPERATOR_RELAY_ACCOUNT_ID is required in relay execution mode.');
    this.#executor = new RelayAgentClient({
      baseUrl: process.env.OPERATOR_RELAY_CONTROL_URL?.trim() || 'http://127.0.0.1:8790',
      token: relayToken,
      accountId,
      deviceId: process.env.OPERATOR_RELAY_DEVICE_ID?.trim() || undefined,
      projectKey: process.env.OPERATOR_RELAY_PROJECT_KEY?.trim() || undefined,
      waitMs: parseWait(process.env.OPERATOR_RELAY_WAIT_MS)
    });
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    return await this.#executor.execute(action);
  }
}

class DirectLocalAgentClient implements Executor {
  #url: URL;
  #token: string;

  constructor(baseUrl: string, token: string) {
    this.#url = new URL('/v1/execute', baseUrl);
    this.#token = token;
  }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(10 * 60_000)
    });
    const body = await response.json() as ActionResult;
    if (!response.ok && !body?.error) throw new Error(`Local agent HTTP ${response.status}`);
    return body;
  }
}

function parseWait(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 10 * 60_000) {
    throw new Error('OPERATOR_RELAY_WAIT_MS must be an integer between 1000 and 600000.');
  }
  return parsed;
}
