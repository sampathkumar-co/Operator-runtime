import fs from 'node:fs/promises';
import path from 'node:path';
import type http from 'node:http';
import { OperatorError } from '../../../src/core/errors.ts';
import {
  OrganizationQuarantineAdjudicator,
  type ProviderQuarantineClaim,
  type QuarantineLedgerAnchor,
  type QuarantineLedgerPosition
} from '../../../src/core/organization-quarantine-adjudication.ts';

const HEX = /^[0-9a-f]{64}$/;
const OPERATOR = /^[A-Za-z0-9._:@/+=-]{1,256}$/;
const SESSION = /^[A-Za-z0-9._~+/=-]{32,4096}$/;
const SETTINGS = [
  'OPERATOR_QUARANTINE_ENABLE', 'OPERATOR_QUARANTINE_REVIEWER_URL',
  'OPERATOR_QUARANTINE_ANCHOR_URL', 'OPERATOR_QUARANTINE_PROVIDER_PUBKEY_FILE',
  'OPERATOR_QUARANTINE_LEDGER_SECRET_FILE',
  'OPERATOR_QUARANTINE_REVIEWER_SERVICE_KEY_FILE',
  'OPERATOR_QUARANTINE_ANCHOR_SERVICE_KEY_FILE'
] as const;
type Config = Record<(typeof SETTINGS)[number], string>;
type ReviewScope = { programId: string; targetKey: string; returnedMissionId: string };
type Fetcher = typeof fetch;

function denied(code: string, message: string): OperatorError {
  return new OperatorError(code, message, { retryable: false });
}
function endpoint(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw denied('QUARANTINE_TRUST_CONFIG_INVALID', name + ' must be an absolute HTTPS URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host === '[::1]' || host === '127.0.0.1' ||
      host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('172.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID',
      name + ' must use a separately operated HTTPS service without URL credentials or query parameters.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
async function material(filename: string, stateDir: string, label: string): Promise<Buffer> {
  if (!path.isAbsolute(filename)) throw denied('QUARANTINE_TRUST_CONFIG_INVALID', label + ' must be an absolute provisioned file.');
  const real = await fs.realpath(filename);
  const state = await fs.realpath(stateDir);
  const within = path.relative(state, real);
  if (!within || (!within.startsWith('..' + path.sep) && within !== '..' && !path.isAbsolute(within))) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', label + ' must be outside the restoreable local state directory.');
  }
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size < 32 || stat.size > 16_384) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', label + ' has invalid bounds or type.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', label + ' must not be group/world readable.');
  }
  return await fs.readFile(real);
}
function position(input: unknown): QuarantineLedgerPosition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw denied('QUARANTINE_ANCHOR_INVALID', 'Independent high-water position is missing.');
  }
  const p = input as Record<string, unknown>;
  if (!Number.isSafeInteger(p.count) || (p.count as number) < 0 ||
      typeof p.headMac !== 'string' || !HEX.test(p.headMac) ||
      (p.count === 0 && p.headMac !== '0'.repeat(64))) {
    throw denied('QUARANTINE_ANCHOR_INVALID', 'Independent high-water position is invalid.');
  }
  return { count: p.count as number, headMac: p.headMac };
}

class HttpsTrustService {
  #url: URL;
  #credential: string;
  #fetch: Fetcher;
  constructor(url: URL, key: Buffer, fetcher: Fetcher) {
    const token = key.toString('utf8').trim();
    if (!SESSION.test(token)) throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'External service credential must be a provisioned bounded token.');
    this.#url = url;
    this.#credential = token;
    this.#fetch = fetcher;
  }
  async request(route: string, payload?: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.#fetch(new URL(route, this.#url), {
        method: payload === undefined ? 'GET' : 'POST',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          'authorization': 'Bearer ' + this.#credential,
          'accept': 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(5000)
      });
    } catch {
      throw denied('QUARANTINE_TRUST_UNAVAILABLE', 'Independent trust service is unavailable; review denied.');
    }
    if (!res.ok) throw denied('QUARANTINE_TRUST_DENIED', 'Independent trust service rejected the operation.');
    if (res.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      throw denied('QUARANTINE_TRUST_INVALID', 'Independent trust service returned a non-JSON response.');
    }
    const length = Number(res.headers.get('content-length') ?? 0);
    if (!Number.isFinite(length) || length > 8192) {
      throw denied('QUARANTINE_TRUST_INVALID', 'Independent trust response exceeds a safe bound.');
    }
    let data: unknown;
    try { data = await res.json(); } catch { throw denied('QUARANTINE_TRUST_INVALID', 'Independent trust response cannot be parsed.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw denied('QUARANTINE_TRUST_INVALID', 'Independent trust response is not a verified object.');
    }
    return data as Record<string, unknown>;
  }
}

/**
 * Opt-in live trust composition. Nothing is enabled with a partial config, a
 * local fallback signer, a memory-only ledger or an unauthenticated reviewer.
 * Services and secret files MUST be provisioned outside the runtime's state,
 * administration and backup domain; the deployment attests that separation.
 */
export async function configureQuarantineProduction(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: Fetcher = fetch
): Promise<{
  adjudicator: OrganizationQuarantineAdjudicator;
  reviewer: (scope: ReviewScope, request: http.IncomingMessage) => Promise<{ operatorId: string }>;
} | null> {
  const requested = SETTINGS.some(name => Boolean(env[name]));
  if (!requested) return null;
  if (env.OPERATOR_QUARANTINE_ENABLE !== '1') {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'Quarantine production review requires an explicit complete opt-in.');
  }
  const config = {} as Config;
  for (const key of SETTINGS) {
    const value = env[key]?.trim();
    if (!value) throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'All independently administered quarantine trust settings are mandatory.');
    config[key] = value;
  }
  const reviewerUrl = endpoint(config.OPERATOR_QUARANTINE_REVIEWER_URL, 'Reviewer URL');
  const anchorUrl = endpoint(config.OPERATOR_QUARANTINE_ANCHOR_URL, 'Anchor URL');
  if (reviewerUrl.hostname === anchorUrl.hostname) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'Reviewer and high-water anchor must have distinct hostname authorities.');
  }
  const filenames = [
    config.OPERATOR_QUARANTINE_PROVIDER_PUBKEY_FILE,
    config.OPERATOR_QUARANTINE_LEDGER_SECRET_FILE,
    config.OPERATOR_QUARANTINE_REVIEWER_SERVICE_KEY_FILE,
    config.OPERATOR_QUARANTINE_ANCHOR_SERVICE_KEY_FILE
  ];
  if (new Set(filenames.map(file => path.resolve(file).toLowerCase())).size !== filenames.length) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'Provider and trust-service credentials must use distinct files.');
  }
  const [providerPem, ledger, reviewerKey, anchorKey] = await Promise.all(
    filenames.map((file, i) => material(file, stateDir, ['Provider key', 'Ledger MAC key', 'Reviewer credential', 'Anchor credential'][i]!))
  );
  if (!providerPem || !ledger || !reviewerKey || !anchorKey ||
      ledger.length < 32 || ledger.length > 256) {
    throw denied('QUARANTINE_TRUST_CONFIG_INVALID', 'Independent ledger MAC key must contain at least 32 bytes.');
  }
  const reviewerService = new HttpsTrustService(reviewerUrl, reviewerKey, fetcher);
  const anchorService = new HttpsTrustService(anchorUrl, anchorKey, fetcher);
  const anchor: QuarantineLedgerAnchor = {
    async read() {
      return position((await anchorService.request('position')).position);
    },
    async compareAndAdvance(expected, next) {
      const result = await anchorService.request('compare-and-advance', { expected, next });
      if (result.ok !== true || !result.position) {
        throw denied('QUARANTINE_ANCHOR_CONFLICT', 'External anchor did not verify its committed successor.');
      }
      const actual = position(result.position);
      if (actual.count !== next.count || actual.headMac !== next.headMac) {
        throw denied('QUARANTINE_ANCHOR_CONFLICT', 'External anchor returned a different authority position.');
      }
    }
  };
  const review = async (payload: Record<string, unknown>): Promise<string> => {
    const data = await reviewerService.request('authorize', payload);
    if (data.authorized !== true || typeof data.operatorId !== 'string' ||
        !OPERATOR.test(data.operatorId)) {
      throw denied('QUARANTINE_OPERATOR_UNAUTHORIZED', 'Independent operator verification did not grant review authority.');
    }
    return data.operatorId;
  };
  const adjudicator = new OrganizationQuarantineAdjudicator(stateDir, {
    providerPublicKeyPem: providerPem.toString('utf8'),
    ledgerSecret: ledger,
    anchor,
    requireExternalAnchor: true,
    authorize: async (operatorId: string, claim: ProviderQuarantineClaim) => {
      const result = await review({ kind: 'provider-claim-authorization', operatorId, claim });
      if (result !== operatorId) throw denied('QUARANTINE_OPERATOR_UNAUTHORIZED', 'Reviewer identity changed during signed claim approval.');
    }
  });
  // Refuse startup if the external anchor is uninitialized or unavailable.
  await anchor.read();
  return {
    adjudicator,
    reviewer: async (scope, req) => {
      const header = req.headers['x-quarantine-review-session'];
      if (typeof header !== 'string' || !SESSION.test(header)) {
        throw denied('QUARANTINE_OPERATOR_UNAUTHORIZED', 'Independent human reviewer session is required.');
      }
      const operatorId = await review({ kind: 'request-bound-review', scope, session: header });
      return { operatorId };
    }
  };
}
