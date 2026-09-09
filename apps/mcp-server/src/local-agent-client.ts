import type { ActionRequest, ActionResult } from '../../../src/core/types.ts';

export class LocalAgentClient {
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
    if (!response.ok && !body?.error) {
      throw new Error(`Local agent HTTP ${response.status}`);
    }
    return body;
  }
}
