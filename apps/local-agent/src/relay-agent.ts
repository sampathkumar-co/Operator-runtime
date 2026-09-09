import fs from 'node:fs/promises';
import path from 'node:path';
import { DeviceIdentityStore } from '../../../src/core/device-identity.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { RelayClient, type RelayDelivery, type RelayRecoveryDecision } from '../../../src/core/relay-client.ts';
import { RelayResultStore } from '../../../src/core/relay-result-store.ts';
import type { ActionRequest } from '../../../src/core/types.ts';

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface LocalAgentRelayRunnerOptions {
  stateDir: string;
  relayUrl: string;
  resultUrl?: string;
  sessionTokenFile: string;
  identity: DeviceIdentityStore;
  localAgentBaseUrl: string;
  agentToken: string;
  allowLoopbackInsecure?: boolean;
}

export class LocalAgentRelayRunner {
  #client: RelayClient;
  #identity: DeviceIdentityStore;
  #outbox: RelayResultStore;
  #sessionTokenFile: string;
  #resultUrl: string;
  #localExecuteUrl: string;
  #agentToken: string;

  constructor(options: LocalAgentRelayRunnerOptions) {
    this.#identity = options.identity;
    this.#outbox = new RelayResultStore(path.join(path.resolve(options.stateDir), 'relay-outbox'));
    this.#sessionTokenFile = path.resolve(options.sessionTokenFile);
    this.#resultUrl = validateResultUrl(options.resultUrl ?? deriveResultUrl(options.relayUrl), Boolean(options.allowLoopbackInsecure));
    this.#localExecuteUrl = new URL('/v1/execute', ensureHttpBase(options.localAgentBaseUrl)).toString();
    this.#agentToken = options.agentToken;
    this.#client = new RelayClient({
      stateDir: options.stateDir,
      url: options.relayUrl,
      identity: options.identity,
      allowLoopbackInsecureWs: Boolean(options.allowLoopbackInsecure),
      getSessionToken: () => this.#readSessionToken(),
      onDelivery: (delivery) => this.#handleDelivery(delivery),
      onRecovery: (context) => this.#handleRecovery(context.delivery)
    });
  }

  run(): Promise<void> { return this.#client.run(); }
  stop(): void { this.#client.stop(); }
  state(): ReturnType<RelayClient['state']> { return this.#client.state(); }

  async #handleDelivery(delivery: RelayDelivery): Promise<void> {
    const identity = await this.#identity.loadOrCreate();
    const result = delivery.kind === 'action'
      ? await this.#executeActionPayload(delivery.payload)
      : { ok: false, error: { code: 'RELAY_DELIVERY_KIND_UNSUPPORTED', message: `Unsupported relay delivery kind ${delivery.kind}.` } };
    const safe = boundedResult(result);
    await this.#outbox.put(identity.deviceId, delivery.seq, delivery.id, safe);
    await this.#submitResult(delivery.seq, delivery.id, safe);
  }

  async #handleRecovery(delivery: RelayDelivery): Promise<RelayRecoveryDecision> {
    const identity = await this.#identity.loadOrCreate();
    const stored = await this.#outbox.get(identity.deviceId, delivery.seq);
    if (!stored || stored.deliveryId !== delivery.id) return 'stop';
    await this.#submitResult(delivery.seq, delivery.id, stored.result);
    return 'ack';
  }

  async #executeActionPayload(payload: JsonObject): Promise<JsonObject> {
    const action = validateRemoteAction(payload.action);
    const response = await fetch(this.#localExecuteUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#agentToken}`
      },
      body: JSON.stringify({ action })
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Local agent returned a non-JSON execution response.', { retryable: false }); }
    if (![200, 409, 423].includes(response.status)) {
      throw new OperatorError('RELAY_LOCAL_EXECUTION_UNCERTAIN', `Local agent returned HTTP ${response.status}; execution state cannot be safely inferred.`, { retryable: false });
    }
    return boundedResult(body);
  }

  async #submitResult(seq: number, deliveryId: string, result: JsonObject): Promise<void> {
    const token = await this.#readSessionToken();
    let response: Response;
    try {
      response = await fetch(this.#resultUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ seq, deliveryId, result })
      });
    } catch (error) {
      throw new OperatorError('RELAY_RESULT_SUBMIT_FAILED', `Relay result submission failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    if (response.status === 200) return;
    let code = 'RELAY_RESULT_SUBMIT_FAILED';
    try { code = String((await response.json() as any)?.error?.code ?? code); } catch { /* bounded generic failure */ }
    const retryable = response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500;
    throw new OperatorError(code, `Relay result service rejected result with HTTP ${response.status}.`, { retryable });
  }

  async #readSessionToken(): Promise<string> {
    let stat;
    try { stat = await fs.lstat(this.#sessionTokenFile); }
    catch { throw new OperatorError('RELAY_SESSION_TOKEN_FILE_MISSING', 'Relay session token file is missing.', { retryable: true }); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > MAX_TOKEN_BYTES) {
      throw new OperatorError('RELAY_SESSION_TOKEN_FILE_INVALID', 'Relay session token file must be a bounded regular file, not a symlink.', { retryable: false });
    }
    const token = (await fs.readFile(this.#sessionTokenFile, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw new OperatorError('RELAY_SESSION_TOKEN_INVALID', 'Relay session token file does not contain a valid token.', { retryable: true });
    }
    return token;
  }
}

function validateRemoteAction(input: unknown): ActionRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action payload must contain an action object.');
  const raw = input as Record<string, unknown>;
  const id = boundedName(raw.id, 'action id');
  const capability = boundedName(raw.capability, 'capability');
  const risk = raw.risk;
  if (!['read', 'write', 'external', 'system', 'destructive'].includes(String(risk))) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action risk is invalid.');
  if (!raw.input || typeof raw.input !== 'object' || Array.isArray(raw.input)) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action input must be an object.');
  const inputText = JSON.stringify(raw.input);
  if (Buffer.byteLength(inputText, 'utf8') > 128 * 1024) throw new OperatorError('RELAY_ACTION_INVALID', 'Relay action input exceeds the bounded size.');
  if (!raw.provenance || typeof raw.provenance !== 'object' || Array.isArray(raw.provenance) || (raw.provenance as any).kind !== 'chatgpt') {
    throw new OperatorError('RELAY_ACTION_PROVENANCE_INVALID', 'Remote relay actions must carry ChatGPT instruction provenance.');
  }
  const taskId = raw.taskId === undefined ? undefined : boundedName(raw.taskId, 'task id');
  const target = raw.target === undefined ? undefined : boundedText(raw.target, 'target', 2048);
  return {
    id,
    capability,
    risk: risk as ActionRequest['risk'],
    input: structuredClone(raw.input as Record<string, unknown>),
    provenance: { kind: 'chatgpt', source: (raw.provenance as any).source === undefined ? undefined : boundedText((raw.provenance as any).source, 'provenance source', 512) },
    taskId,
    target
  };
}

function boundedResult(input: unknown): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Relay action result must be a JSON object.');
  let text: string;
  try { text = JSON.stringify(input); } catch { throw new OperatorError('RELAY_LOCAL_RESULT_INVALID', 'Relay action result is not JSON serializable.'); }
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new OperatorError('RELAY_LOCAL_RESULT_TOO_LARGE', 'Relay action result exceeds the bounded result size.');
  return JSON.parse(text) as JsonObject;
}

function boundedName(input: unknown, label: string): string {
  const value = String(input ?? '');
  if (!value || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new OperatorError('RELAY_ACTION_INVALID', `Relay ${label} is invalid.`);
  return value;
}

function boundedText(input: unknown, label: string, max: number): string {
  const value = String(input ?? '');
  if (!value || Buffer.byteLength(value, 'utf8') > max) throw new OperatorError('RELAY_ACTION_INVALID', `Relay ${label} is invalid.`);
  return value;
}

function deriveResultUrl(relayUrlInput: string): string {
  let relay: URL;
  try { relay = new URL(relayUrlInput); } catch { throw new OperatorError('RELAY_URL_INVALID', 'Relay URL is invalid.'); }
  relay.protocol = relay.protocol === 'wss:' ? 'https:' : relay.protocol === 'ws:' ? 'http:' : relay.protocol;
  relay.pathname = '/v1/device-result'; relay.search = ''; relay.hash = '';
  return relay.toString();
}

function validateResultUrl(input: string, allowLoopbackInsecure: boolean): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL is invalid.'); }
  if (url.username || url.password || url.hash) throw new OperatorError('RELAY_RESULT_URL_INVALID', 'Relay result URL must not contain credentials or a fragment.');
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && allowLoopbackInsecure && isLoopback(url.hostname)) return url.toString();
  throw new OperatorError('RELAY_RESULT_TLS_REQUIRED', 'Relay results require HTTPS; insecure HTTP is allowed only for explicit loopback development.');
}

function ensureHttpBase(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new OperatorError('RELAY_LOCAL_AGENT_URL_INVALID', 'Local agent base URL is invalid.'); }
  if (url.protocol !== 'http:' || !isLoopback(url.hostname) || url.username || url.password) throw new OperatorError('RELAY_LOCAL_AGENT_URL_INVALID', 'Relay runner may call only a loopback HTTP local-agent endpoint.');
  return url.toString();
}

function isLoopback(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}
