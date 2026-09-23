import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_CLIENT_ID = 'mecord-device-pairing-v1';
const DEFAULT_AUTHORIZATION_URL = 'https://auth.splcart.in/api/oidc/authorization';
const DEFAULT_TOKEN_URL = 'https://auth.splcart.in/api/oidc/token';
const DEFAULT_REDIRECT_URI = 'https://auth.splcart.in/pair/callback';
const DEFAULT_RESOURCE = 'https://operator.splcart.in/mcp';
const DEFAULT_CLAIM_URL = 'https://operator.splcart.in/pair/api/claim';
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_PENDING = 512;

function fixedHttpsUrl(input, label, expectedPath) {
  let url;
  try { url = new URL(String(input || '')); } catch { throw new Error(`${label} is invalid.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without query or fragment.`);
  }
  if (expectedPath && url.pathname !== expectedPath) throw new Error(`${label} path is invalid.`);
  return url;
}

export function normalizePairingCode(input) {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) {
    throw new Error('PAIR_CODE_INVALID');
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function boundedOAuthValue(value, label, max = 4096) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\0\r\n]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

export function createPairingService(options = {}) {
  const clientId = boundedOAuthValue(options.clientId || process.env.PORTAL_PAIR_CLIENT_ID || DEFAULT_CLIENT_ID, 'Pairing client ID', 512);
  const authorizationUrl = fixedHttpsUrl(options.authorizationUrl || process.env.PORTAL_PAIR_AUTHORIZATION_URL || DEFAULT_AUTHORIZATION_URL, 'Pairing authorization URL', '/api/oidc/authorization');
  const tokenUrl = fixedHttpsUrl(options.tokenUrl || process.env.PORTAL_PAIR_TOKEN_URL || DEFAULT_TOKEN_URL, 'Pairing token URL', '/api/oidc/token');
  const redirectUri = fixedHttpsUrl(options.redirectUri || process.env.PORTAL_PAIR_REDIRECT_URI || DEFAULT_REDIRECT_URI, 'Pairing redirect URI', '/pair/callback');
  const resource = fixedHttpsUrl(options.resource || process.env.PORTAL_PAIR_RESOURCE || DEFAULT_RESOURCE, 'Pairing resource URL', '/mcp');
  const claimUrl = fixedHttpsUrl(options.claimUrl || process.env.PORTAL_PAIR_CLAIM_URL || DEFAULT_CLAIM_URL, 'Pairing claim URL', '/pair/api/claim');
  const ttlMs = Number(options.ttlMs || DEFAULT_TTL_MS);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 15 * 60_000) throw new Error('Pairing state TTL is invalid.');
  const clock = options.clock || (() => Date.now());
  const fetchFn = options.fetchFn || fetch;
  const pending = new Map();

  function prune() {
    const now = clock();
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
    if (pending.size <= MAX_PENDING) return;
    const entries = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [state] of entries.slice(0, pending.size - MAX_PENDING)) pending.delete(state);
  }

  function start(userCodeInput) {
    prune();
    const userCode = normalizePairingCode(userCodeInput);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const createdAt = clock();
    pending.set(state, { userCode, verifier, createdAt, expiresAt: createdAt + ttlMs });

    const url = new URL(authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri.toString());
    url.searchParams.set('scope', 'openid operator:read operator:write');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', resource.toString());
    return { authorizationUrl: url.toString(), expiresAt: new Date(createdAt + ttlMs).toISOString() };
  }

  async function complete({ code: codeInput, state: stateInput }) {
    prune();
    const state = boundedOAuthValue(stateInput, 'OAuth state', 512);
    const entry = pending.get(state);
    if (!entry || entry.expiresAt <= clock()) {
      pending.delete(state);
      throw new Error('PAIR_STATE_INVALID');
    }
    pending.delete(state);
    const code = boundedOAuthValue(codeInput, 'Authorization code', 8192);

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri.toString(),
      code_verifier: entry.verifier
    });
    const tokenResponse = await fetchFn(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(15_000)
    });
    const tokenJson = await tokenResponse.json().catch(() => ({}));
    const accessToken = typeof tokenJson?.access_token === 'string' ? tokenJson.access_token : '';
    if (!tokenResponse.ok || !accessToken || accessToken.length > 16_384 || /[\r\n]/.test(accessToken)) {
      throw new Error('PAIR_TOKEN_EXCHANGE_FAILED');
    }

    const claimResponse = await fetchFn(claimUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ userCode: entry.userCode }),
      signal: AbortSignal.timeout(15_000)
    });
    const claimJson = await claimResponse.json().catch(() => ({}));
    if (!claimResponse.ok || claimJson?.ok !== true || claimJson?.status !== 'claimed') {
      const code = typeof claimJson?.error?.code === 'string' ? claimJson.error.code : 'PAIR_CLAIM_FAILED';
      throw new Error(code);
    }
    return { status: 'claimed', userCode: entry.userCode };
  }

  return { start, complete, pendingCount: () => pending.size };
}
