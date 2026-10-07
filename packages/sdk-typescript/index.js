export class MecordGatewayClient {
  #baseUrl; #token; #fetch;
  constructor(options) {
    this.#baseUrl = new URL(options.baseUrl);
    if (!['https:','http:'].includes(this.#baseUrl.protocol)) throw new Error('Gateway baseUrl must use HTTP(S).');
    if (this.#baseUrl.protocol === 'http:' && !['localhost','127.0.0.1','::1'].includes(this.#baseUrl.hostname)) throw new Error('Plain HTTP is restricted to loopback.');
    this.#token = options.bearerToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }
  proposal(input) {
    return { schemaVersion:1, ...input, proposedAt: input.proposedAt ?? new Date().toISOString() };
  }
  async execute(proposal) {
    const token = typeof this.#token === 'function' ? await this.#token() : this.#token;
    if (typeof token !== 'string' || token.length < 16) throw new Error('Gateway bearer token is invalid.');
    const response = await this.#fetch(new URL('/v1/gateway/execute', this.#baseUrl), {
      method:'POST', redirect:'error',
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
      body:JSON.stringify(proposal)
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? `Gateway rejected request with HTTP ${response.status}.`);
      error.code = body?.error?.code;
      throw error;
    }
    return body;
  }
}
