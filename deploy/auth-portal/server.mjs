import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Algorithm, hash as argon2Hash } from '@node-rs/argon2';
import YAML from 'yaml';
import { createPairingService } from './pairing.mjs';
import { accountDashboardPage } from './account-dashboard.mjs';

const port = Number(process.env.PORT || 8090);
const usersFile = process.env.PORTAL_USERS_FILE || '/data/users_database.yml';
const inviteHash = (process.env.PORTAL_INVITE_SHA256 || '').trim().toLowerCase();
const signupMode = (process.env.PORTAL_SIGNUP_MODE || 'invite').trim().toLowerCase();
if (signupMode !== 'invite' && signupMode !== 'open') throw new Error('INVALID_SIGNUP_MODE');
const openSignup = signupMode === 'open';
const defaultGroup = process.env.PORTAL_DEFAULT_GROUP || 'operator-users';
if (openSignup && defaultGroup !== 'operator-users') throw new Error('OPEN_SIGNUP_REQUIRES_OPERATOR_USERS');
const challengeSecret = (process.env.PORTAL_CHALLENGE_SECRET || '').trim();
if (openSignup && challengeSecret.length < 32) throw new Error('OPEN_SIGNUP_REQUIRES_CHALLENGE_SECRET');
const securityStateFile = process.env.PORTAL_SECURITY_STATE_FILE || usersFile + '.portal-security.json';
if (openSignup && !process.env.PORTAL_MAX_USERS) throw new Error('OPEN_SIGNUP_REQUIRES_MAX_USERS');
const maxUsers = Number(process.env.PORTAL_MAX_USERS || 1000);
if (!Number.isSafeInteger(maxUsers) || maxUsers < 1) throw new Error('INVALID_PORTAL_MAX_USERS');
const rawTrustedProxyIps = String(process.env.PORTAL_TRUSTED_PROXY_IPS || '').split(',').map((value) => value.trim()).filter(Boolean);
const normalizedTrustedProxyIps = rawTrustedProxyIps.map((value) => normalizeIp(value));
if (normalizedTrustedProxyIps.some((value) => !value)) throw new Error('INVALID_PORTAL_TRUSTED_PROXY_IPS');
if (normalizedTrustedProxyIps.length === 0) throw new Error(openSignup ? 'OPEN_SIGNUP_REQUIRES_TRUSTED_PROXY_IPS' : 'INVITE_SIGNUP_REQUIRES_TRUSTED_PROXY_IPS');
const trustedProxyIps = new Set(normalizedTrustedProxyIps);
const challengeMinAgeMs = process.env.NODE_ENV === 'test' ? Number(process.env.PORTAL_CHALLENGE_MIN_AGE_MS || 0) : 3000;
const maxRateBuckets = 10_000;
const maxBody = 16 * 1024;
const pairAttempts = new Map();
const pairing = createPairingService();
const accountSessions = new Map();
const browserFlows = new Map();
const accountSessionLifetimeMs = 10 * 60_000;
const accountSessionLimit = 512;
const publicOrigin = 'https://auth.splcart.in';
const relayClaimUrl = new URL(process.env.PORTAL_PAIR_CLAIM_URL || 'https://operator.splcart.in/pair/api/claim');
if (relayClaimUrl.protocol !== 'https:' || relayClaimUrl.pathname !== '/pair/api/claim' || relayClaimUrl.username || relayClaimUrl.password || relayClaimUrl.search || relayClaimUrl.hash) {
  throw new Error('INVALID_PORTAL_PAIR_CLAIM_URL');
}
const accountListUrl = new URL('/pair/api/devices', relayClaimUrl).toString();
const accountRemoveUrl = new URL('/pair/api/devices/remove', relayClaimUrl).toString();

function sessionHash(token) { return createHash('sha256').update(token).digest('hex'); }
function rawCookie(req, name) {
  const pair = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return pair ? pair.slice(name.length + 1) : '';
}
function browserFlowCookie(nonce, maxAge) {
  return 'mecord_flow=' + nonce + '; Path=/pair/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}
function bindBrowserFlow(state) {
  const now = Date.now();
  for (const [key, entry] of browserFlows) if (entry.expiresAt <= now) browserFlows.delete(key);
  while (browserFlows.size >= 512) browserFlows.delete(browserFlows.keys().next().value);
  const nonce = randomBytes(32).toString('base64url');
  browserFlows.set(state, { nonceHash: sessionHash(nonce), expiresAt: now + 10 * 60_000 });
  return nonce;
}
function consumeBrowserFlow(req, state) {
  const record = browserFlows.get(state);
  browserFlows.delete(state);
  const nonce = rawCookie(req, 'mecord_flow');
  if (!record || record.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return false;
  const actual = Buffer.from(sessionHash(nonce), 'hex'), expected = Buffer.from(record.nonceHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function pruneAccountSessions() {
  for (const [key, item] of accountSessions) if (item.expiresAt <= Date.now()) accountSessions.delete(key);
  while (accountSessions.size >= accountSessionLimit) accountSessions.delete(accountSessions.keys().next().value);
}
function newAccountSession(accessToken, expiresIn) {
  pruneAccountSessions();
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + Math.min(accountSessionLifetimeMs, Math.max(1, expiresIn) * 1000);
  accountSessions.set(sessionHash(token), { accessToken, csrf, expiresAt });
  return { token, expiresAt };
}
function currentAccountSession(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim());
  const found = cookies.find(s => s.startsWith('mecord_account='));
  const token = found?.slice('mecord_account='.length) ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const key = sessionHash(token);
  const record = accountSessions.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) { accountSessions.delete(key); return null; }
  return { ...record, key };
}
function accountCookie(token, maxAge) {
  // The management token is opaque, HttpOnly and never shared with the relay API.
  return 'mecord_account=' + token + '; Path=/account; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}
function sameOriginPost(req) {
  return req.headers.origin === (process.env.NODE_ENV === 'test' ? 'http://127.0.0.1:' + port : publicOrigin);
}
function accountCsrfAuthorized(req, session) {
  return session && sameOriginPost(req) && typeof req.headers['x-mecord-csrf'] === 'string' &&
    req.headers['x-mecord-csrf'].length === session.csrf.length &&
    timingSafeEqual(Buffer.from(req.headers['x-mecord-csrf']), Buffer.from(session.csrf));
}
async function relayAccountRequest(url, token, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok !== true) {
    return { ok: false, status: response.status === 401 ? 401 : response.status === 403 ? 403 : 503 };
  }
  return { ok: true, result };
}
function redirect(res, target, cookie) {
  res.writeHead(303, { location: target, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
}
let writeQueue = Promise.resolve();

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...extraHeaders
  });
  res.end(payload);
}

function hashInvite(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validInvite(value) {
  if (!inviteHash || !/^[a-f0-9]{64}$/.test(inviteHash)) return false;
  const actual = Buffer.from(hashInvite(value), 'hex');
  const expected = Buffer.from(inviteHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeIp(value) {
  const candidate = String(value || '').trim().replace(/^::ffff:/, '');
  return isIP(candidate) ? candidate : '';
}

function clientIp(req) {
  const peer = normalizeIp(req.socket.remoteAddress) || 'unknown';
  const forwarded = normalizeIp(req.headers['x-real-ip']);
  return trustedProxyIps.has(peer) && forwarded ? forwarded : peer;
}

function rateAllowed(store, ip) {
  const now = Date.now();
  const key = createHmac('sha256', challengeSecret || inviteHash || 'invite-mode').update(ip).digest('hex');
  if (!store.attempts[key] && Object.keys(store.attempts).length >= maxRateBuckets) {
    const oldest = Object.entries(store.attempts).sort((left, right) => Number(left[1]?.reset || 0) - Number(right[1]?.reset || 0))[0];
    if (oldest) delete store.attempts[oldest[0]];
  }
  const item = store.attempts[key] || { count: 0, reset: now + 15 * 60_000 };
  if (now > item.reset) {
    item.count = 0;
    item.reset = now + 15 * 60_000;
  }
  item.count += 1;
  store.attempts[key] = item;
  return item.count <= (openSignup ? 4 : 8);
}

function emptySecurityState() {
  return { attempts: {} };
}

async function readSecurityState() {
  try {
    const value = JSON.parse(await fs.readFile(securityStateFile, 'utf8'));
    return {
      attempts: value?.attempts && typeof value.attempts === 'object' ? value.attempts : {}
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySecurityState();
    throw new Error('SIGNUP_SECURITY_STATE_INVALID');
  }
}

async function writeSecurityState(state) {
  const temp = securityStateFile + '.tmp';
  await fs.writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, securityStateFile);
}

function issueSignupChallenge(ip) {
  const issuedAt = Date.now();
  const client = createHmac('sha256', challengeSecret).update(ip).digest('base64url');
  const value = Buffer.from(JSON.stringify({ nonce: randomBytes(18).toString('base64url'), client, issuedAt, expiresAt: issuedAt + 15 * 60_000 })).toString('base64url');
  const signature = createHmac('sha256', challengeSecret).update(value).digest('base64url');
  return { token: value + '.' + signature, minAgeMs: challengeMinAgeMs, readyAt: issuedAt + challengeMinAgeMs, expiresAt: issuedAt + 15 * 60_000 };
}

function verifySignupChallenge(token, ip) {
  const [value, suppliedSignature, extra] = String(token || '').split('.');
  if (!value || !suppliedSignature || extra) return false;
  const expectedSignature = createHmac('sha256', challengeSecret).update(value).digest();
  let actualSignature;
  try { actualSignature = Buffer.from(suppliedSignature, 'base64url'); } catch { return false; }
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return false; }
  const now = Date.now();
  if (!/^[A-Za-z0-9_-]{24}$/.test(payload?.nonce || '')) return false;
  const expectedClient = createHmac('sha256', challengeSecret).update(ip).digest();
  let actualClient;
  try { actualClient = Buffer.from(payload?.client || '', 'base64url'); } catch { return false; }
  if (actualClient.length !== expectedClient.length || !timingSafeEqual(actualClient, expectedClient)) return false;
  if (!Number.isSafeInteger(payload?.issuedAt) || !Number.isSafeInteger(payload?.expiresAt)) return false;
  if (now < payload.issuedAt + challengeMinAgeMs || now > payload.expiresAt || payload.expiresAt - payload.issuedAt !== 15 * 60_000) return false;
  return true;
}

function pruneSecurityState(state) {
  const now = Date.now();
  for (const [key, item] of Object.entries(state.attempts)) if (!item || Number(item.reset) < now) delete state.attempts[key];
}

function pairRateAllowed(ip) {
  const now = Date.now();
  const item = pairAttempts.get(ip) || { count: 0, reset: now + 15 * 60_000 };
  if (now > item.reset) {
    item.count = 0;
    item.reset = now + 15 * 60_000;
  }
  item.count += 1;
  pairAttempts.set(ip, item);
  return item.count <= 20;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function makePasswordHash(password) {
  return await argon2Hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
    outputLen: 32
  });
}

async function createUser({ username, email, password, invite }) {
  username = String(username || '').trim().toLowerCase();
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  invite = String(invite || '');

  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return { status: 400, body: { ok: false, error: 'Use 3-32 lowercase letters, numbers, dot, dash or underscore.' } };
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 400, body: { ok: false, error: 'Enter a valid email address.' } };
  }
  if (password.length < 12 || password.length > 128) {
    return { status: 400, body: { ok: false, error: 'Password must be 12-128 characters.' } };
  }
  if (!openSignup && !validInvite(invite)) {
    return { status: 403, body: { ok: false, error: 'Registration code is invalid.' } };
  }

  const raw = await fs.readFile(usersFile, 'utf8');
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length) throw new Error('USERS_DATABASE_INVALID');
  if (doc.get('users') === undefined) doc.set('users', {});
  if (doc.getIn(['users', username]) !== undefined) {
    return { status: 409, body: { ok: false, error: 'That username already exists.' } };
  }
  const snapshot = doc.toJS() || {};
  const userCount = Object.keys(snapshot.users || {}).length;
  if (openSignup && userCount >= maxUsers) {
    return { status: 503, body: { ok: false, error: 'Account capacity has been reached. Contact support.' } };
  }
  const duplicateEmail = Object.values(snapshot.users || {}).some((entry) =>
    String(entry?.email || '').trim().toLowerCase() === email
  );
  if (duplicateEmail) {
    return { status: 409, body: { ok: false, error: 'That email is already in use.' } };
  }

  const digest = await makePasswordHash(password);
  doc.setIn(['users', username], {
    disabled: false,
    displayname: username,
    password: digest,
    email,
    groups: [defaultGroup]
  });

  const backup = usersFile + '.portal-backup';
  await fs.copyFile(usersFile, backup);
  const temp = usersFile + '.portal-tmp';
  await fs.writeFile(temp, doc.toString(), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, usersFile);
  return { status: 201, body: { ok: true, username } };
}
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mecord Connect - Account</title>
<style>
:root{--ink:#111827;--muted:#697386;--panel:#fff;--bg:#f4f7fb;--brand:#2563eb;--brand2:#4f46e5;--good:#15803d;--bad:#c2414b}*{box-sizing:border-box}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 12% 12%,#e9efff 0,transparent 28%),radial-gradient(circle at 90% 88%,#eef2ff 0,transparent 24%),var(--bg);display:grid;min-height:100vh;place-items:center;padding:32px}
.shell{width:min(1080px,100%);min-height:650px;display:grid;grid-template-columns:.9fr 1.1fr;background:var(--panel);border:1px solid rgba(17,24,39,.08);border-radius:28px;overflow:hidden;box-shadow:0 30px 90px rgba(27,42,78,.16)}
.brand{position:relative;padding:42px;background:linear-gradient(145deg,#0f172a 0%,#172554 45%,#1d4ed8 100%);color:#fff;text-align:left;margin:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden}.brand:after{content:"";position:absolute;right:-90px;bottom:-110px;width:330px;height:330px;border-radius:50%;background:rgba(255,255,255,.07)}.mark{width:48px;height:48px;margin:0 0 28px;border:1px solid rgba(255,255,255,.25);border-radius:14px;display:grid;place-items:center;font-weight:850;font-size:15px;background:rgba(255,255,255,.12)}
.brand h1{position:relative;margin:0 0 14px;font-size:42px;line-height:1.03;letter-spacing:-.045em;max-width:360px}.brand p{position:relative;margin:0;color:#dbe4ff;font-size:15px;line-height:1.65;max-width:365px}
.brand-lockup{position:absolute;top:38px;left:42px;display:flex;align-items:center;gap:12px;font-size:18px;font-weight:800;z-index:2}.brand-lockup .mark{margin:0}.hero-copy{position:relative;z-index:2}.eyebrow{font-size:11px;letter-spacing:.12em;font-weight:800;color:#bfdbfe;margin-bottom:17px}.hero-proof{position:absolute;left:42px;bottom:40px;z-index:2;display:grid;gap:9px;font-size:12px;color:#dbeafe}.card{padding:56px 64px;background:#fff;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column;justify-content:center}
.tabs{display:grid;grid-template-columns:1fr 1fr;background:#f1f5f9;border-radius:12px;padding:4px;margin-bottom:28px}
.tab{margin:0;border:0;border-radius:9px;padding:11px;background:transparent;color:#64748b;font-weight:750;cursor:pointer}
.tab.active{background:#fff;color:#0f172a;box-shadow:0 1px 5px rgba(15,23,42,.09)}
.pane{display:none}.pane.active{display:block}
h2{margin:0 0 7px;font-size:29px;letter-spacing:-.035em}p.help{margin:0 0 22px;color:var(--muted);font-size:14px;line-height:1.5}
label{display:block;margin:14px 0 7px;font-size:13px;font-weight:720;color:#334155}
input{width:100%;height:48px;padding:0 13px;border-radius:11px;border:1px solid #dbe1ea;background:#fff;color:#0f172a;font-size:15px;outline:none;transition:.16s}
input:focus{border-color:#7aa2ff;box-shadow:0 0 0 4px rgba(37,99,235,.10)}
.primary{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:800;font-size:15px;cursor:pointer}
.primary:disabled{opacity:.65;cursor:wait}.secondary{background:transparent;border:0;color:#255edc;cursor:pointer;font-weight:700;padding:0}
.row{display:flex;align-items:center;gap:8px;margin-top:12px;color:#64748b;font-size:13px}.row input{width:auto}
.msg{min-height:22px;margin-top:12px;font-size:13px;line-height:1.4}.ok{color:#85dfa7}.bad{color:#ffaaaa}
.consent-list{display:grid;gap:10px;margin:20px 0;padding:0;list-style:none}.consent-list li{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #e2e8f0;border-radius:11px;background:#f8fafc;color:#334155;font-size:13px;line-height:1.45}.consent-list li:before{content:"✓";color:#2563eb;font-weight:850}.consent-target{margin-top:14px;padding:11px 12px;border-radius:10px;background:#eff6ff;color:#1e3a8a;font-size:12px;overflow-wrap:anywhere}
.switch{text-align:center;margin-top:16px;color:#bbb;font-size:13px}
.toplinks{display:flex;align-items:center;justify-content:flex-end;gap:20px;margin-bottom:22px;font-size:13px;font-weight:750;color:#2d5fd4}.toplinks a:hover{text-decoration:underline}.toplinks button:hover{text-decoration:underline}
.footer{grid-column:2;text-align:center;color:#94a3b8;font-size:11px;margin:-38px 0 20px}
@media(max-width:820px){body{padding:0;background:#fff}.shell{min-height:100vh;display:block;border:0;border-radius:0}.brand{display:none}.card{padding:34px 22px;min-height:calc(100vh - 48px)}.footer{grid-column:auto;margin:20px}}</style>
</head>
<body><main class="shell">
<div class="brand"><div class="brand-lockup"><div class="mark">MC</div><span>Mecord Connect</span></div><div class="hero-copy"><div class="eyebrow">SECURE DEVICE BRIDGE</div><h1>Your computer, available to ChatGPT.</h1><p>Work with your authorized projects while your device permissions and local policy stay in control.</p></div><div class="hero-proof"><span>✓ Device-scoped access</span><span>✓ Local approval boundary</span><span>✓ One account, multiple devices</span></div></div>
<section class="card">
<div class="toplinks" aria-label="Account actions"><a href="/account">My devices</a><button id="changeAccount" class="secondary" type="button">Switch account</button></div>
<div class="tabs">
<button id="signInTab" class="tab active" type="button">Sign in</button>
<button id="signUpTab" class="tab" type="button">Create account</button>
</div>
<div id="signInPane" class="pane active">
<h2>Sign in</h2><p class="help">Use your Mecord Connect account to continue.</p>
<form id="signInForm">
<label for="loginUsername">Username</label><input id="loginUsername" autocomplete="username" required>
<label for="loginPassword">Password</label><input id="loginPassword" type="password" autocomplete="current-password" required>
<div class="row"><input id="remember" type="checkbox"><label for="remember" style="margin:0;font-weight:500">Remember me</label></div>
<button id="signInButton" class="primary" type="submit">Sign in</button>
<div id="loginMsg" class="msg"></div>
</form>
<div class="switch">New here? <button id="createInstead" class="secondary" type="button">Create an account</button></div>
</div>
<div id="signUpPane" class="pane">
<h2>Create account</h2><p class="help">Choose your username, email address, and a strong password.${openSignup ? "" : " A registration code is required for this private signup."}</p>
<form id="signUpForm">
<label for="signupUsername">Username</label><input id="signupUsername" autocomplete="username" required placeholder="sampath">
<label for="signupEmail">Email</label><input id="signupEmail" type="email" autocomplete="email" required placeholder="you@example.com">
<label for="signupPassword">Password</label><input id="signupPassword" type="password" autocomplete="new-password" required minlength="12">
<label for="signupConfirm">Confirm password</label><input id="signupConfirm" type="password" autocomplete="new-password" required minlength="12">
${openSignup ? "" : '<label for="signupInvite">Registration code</label><input id="signupInvite" type="password" autocomplete="one-time-code" required>'}
<button id="signUpButton" class="primary" type="submit">Create account</button>
<div id="signupMsg" class="msg"></div>
</form>
<div class="switch">Already have an account? <button id="signinInstead" class="secondary" type="button">Sign in</button></div>
</div>
<div id="oauthConsentPane" class="pane">
<h2 id="oauthConsentTitle">Connect to ChatGPT</h2><p id="oauthConsentHelp" class="help">Review the access requested for this Mecord Connect session.</p>
<ul id="oauthConsentScopes" class="consent-list"></ul>
<div id="oauthConsentTarget" class="consent-target"></div>
<button id="oauthConsentButton" class="primary" type="button">Allow and continue</button>
<div id="oauthConsentMsg" class="msg"></div>
</div>
</section>
<div class="footer">Mecord Connect · Secure account access</div>
</main>
<script>
(function(){
  const byId=(id)=>document.getElementById(id);
  const signInTab=byId('signInTab'),signUpTab=byId('signUpTab');
  const signInPane=byId('signInPane'),signUpPane=byId('signUpPane'),oauthConsentPane=byId('oauthConsentPane');
  let oauthConsent,signupChallenge;
  async function loadSignupChallenge(){
    if(!${openSignup})return;
    const r=await fetch('/signup/challenge',{credentials:'same-origin'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.token)throw new Error('Secure signup could not be prepared.');
    signupChallenge={...j, receivedAt:performance.now()};
  }
  function show(which){
    const login=which==='signin';
    const signup=which==='signup',consent=which==='consent';
    signInTab.classList.toggle('active',login); signUpTab.classList.toggle('active',signup);
    signInPane.classList.toggle('active',login); signUpPane.classList.toggle('active',signup); oauthConsentPane.classList.toggle('active',consent);
    document.querySelector('.tabs').style.display=consent?'none':'grid';
    setTimeout(()=>{ const el=byId(login?'loginUsername':'signupUsername'); if(el) el.focus(); },0);
  }
  async function clearDashboardSession(){
    const session=await fetch('/account/api/session',{credentials:'same-origin',cache:'no-store'});
    if(!session.ok)throw new Error('Could not validate account session.');
    const data=await session.json();
    if(!data.active)return;
    const closed=await fetch('/account/logout',{method:'POST',credentials:'same-origin',headers:{'x-mecord-csrf':data.csrf}});
    if(!closed.ok)throw new Error('Could not clear existing device-management session.');
  }
  async function switchAccount(){
    const button=byId('changeAccount');button.disabled=true;
    try{
      await clearDashboardSession();
      const r=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({targetURL:'https://auth.splcart.in/signin'})});
      if(!r.ok)throw new Error('Could not end the current sign-in session.');
      location.replace('/signin?switched=1');
    }catch(e){const m=byId('loginMsg');m.className='msg bad';m.textContent=e.message||'Switch account failed.';button.disabled=false;}
  }
  byId('changeAccount').onclick=switchAccount;
  signInTab.onclick=()=>show('signin'); signUpTab.onclick=()=>show('signup');
  byId('createInstead').onclick=()=>show('signup'); byId('signinInstead').onclick=()=>show('signin');
  if(location.pathname==='/signup') show('signup');
  if(location.search.includes('logged_out=1')||location.search.includes('switched=1')){
    const msg=byId('loginMsg');msg.className='msg';msg.textContent='Signed out. You can now use another account.';
  }
  if(${openSignup})loadSignupChallenge().catch(()=>{});
  if(location.pathname==='/recover') {
    show('signin');
    const msg=byId('loginMsg');
    msg.className='msg bad';
    msg.textContent='This connection is no longer valid. Return to ChatGPT and click Connect again.';
    byId('signInButton').disabled=true;
    byId('loginUsername').disabled=true;
    byId('loginPassword').disabled=true;
  }

  const oauthQuery=new URLSearchParams(location.search);
  const oauthFlow=oauthQuery.get('flow'),oauthFlowID=oauthQuery.get('flow_id');
  const activeOAuth=location.pathname==='/consent/openid/decision'&&oauthFlow==='openid_connect'&&Boolean(oauthFlowID);
  const responseData=(value)=>value&&value.data?value.data:value;
  const scopeLabels={
    openid:'Verify your Mecord Connect identity',
    email:'Share the email address on your Mecord account',
    offline_access:'Keep the connection available until you disconnect it',
    'operator:read':'Inspect authorized projects and device status',
    'operator:write':'Perform changes you explicitly request and approve',
    'operator:developer':'Use advanced Mecord developer automation on explicitly entitled devices',
    profile:'Share your basic Mecord profile'
  };
  async function loadOAuthConsent(silent){
    if(!activeOAuth)return false;
    const r=await fetch('/api/oidc/consent?flow_id='+encodeURIComponent(oauthFlowID),{credentials:'same-origin'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||j.status==='KO'){
      if(!silent){const msg=byId('loginMsg');msg.className='msg bad';msg.textContent='Signed in, but this connection could not continue. Return to ChatGPT and click Connect again.';byId('signInButton').disabled=false;}
      return false;
    }
    const data=responseData(j);
    if(!data||!data.client_id)return false;
    oauthConsent=data;
    const pairingClient=data.client_id==='mecord-device-pairing-v1';
    byId('oauthConsentTitle').textContent=pairingClient?'Authorize Mecord access':'Connect to ChatGPT';
    byId('oauthConsentHelp').textContent=pairingClient
      ?'Approve access to pair or manage computers under your currently signed-in Mecord account.'
      :'Review the access requested for this Mecord Connect session.';
    byId('oauthConsentButton').textContent=pairingClient?'Continue securely':'Allow and continue';
    const list=byId('oauthConsentScopes');list.textContent='';
    for(const scope of (data.scopes||[])){
      const item=document.createElement('li');item.textContent=scopeLabels[scope]||('Grant '+scope+' access');list.appendChild(item);
    }
    const targets=Array.isArray(data.resource)&&data.resource.length?data.resource:(data.audience||[]);
    byId('oauthConsentTarget').textContent=targets.length?'Connection target: '+targets.join(', '):'Connection target: Mecord Connect';
    show('consent');return true;
  }
  if(activeOAuth)loadOAuthConsent(true).catch(()=>{});

  byId('oauthConsentButton').addEventListener('click',async()=>{
    const btn=byId('oauthConsentButton'),msg=byId('oauthConsentMsg');
    if(!oauthConsent||!oauthFlowID)return;
    btn.disabled=true;msg.className='msg';msg.textContent='Authorizing...';
    const body={flow_id:oauthFlowID,client_id:oauthConsent.client_id,consent:true,pre_configure:false,claims:Array.isArray(oauthConsent.claims)?oauthConsent.claims:[]};
    const subflow=oauthQuery.get('subflow'),userCode=oauthQuery.get('user_code');
    if(subflow)body.subflow=subflow;if(userCode)body.user_code=userCode;
    try{
      const r=await fetch('/api/oidc/consent',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json().catch(()=>({}));const data=responseData(j);
      if(!r.ok||j.status==='KO'||!data||!data.redirect_uri)throw new Error('Authorization could not be completed.');
      msg.className='msg ok';msg.textContent='Authorized. Returning to ChatGPT...';location.assign(data.redirect_uri);
    }catch(err){msg.className='msg bad';msg.textContent=(err&&err.message)||'Authorization could not be completed.';btn.disabled=false;}
  });

  byId('signInForm').addEventListener('submit',async(ev)=>{
    ev.preventDefault();
    const msg=byId('loginMsg'),btn=byId('signInButton');
    msg.className='msg'; msg.textContent='Signing in...'; btn.disabled=true;
    const q=new URLSearchParams(location.search);
    const body={
      username:byId('loginUsername').value.trim(),
      password:byId('loginPassword').value,
      keepMeLoggedIn:byId('remember').checked
    };
    const optional={targetURL:q.get('rd'),requestMethod:q.get('rm'),flowID:q.get('flow_id'),flow:q.get('flow'),subflow:q.get('subflow'),userCode:q.get('user_code')};
    for(const k in optional){ if(optional[k]) body[k]=optional[k]; }
    try{
      const r=await fetch('/api/firstfactor',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json().catch(()=>({}));
      if(!r.ok||j.status==='KO') throw new Error('Incorrect username or password.');
      const redirect=(j.data&&j.data.redirect)||j.redirect;
      msg.className='msg ok'; msg.textContent='Signed in. Continuing...';
      byId('loginPassword').value='';
      if(redirect){ location.assign(redirect); return; }
      if(await loadOAuthConsent(false))return;
      location.assign(activeOAuth?'/recover':'/account');
    }catch(err){
      msg.className='msg bad'; msg.textContent=(err&&err.message)||'Sign in failed.';
      byId('loginPassword').value=''; btn.disabled=false; byId('loginPassword').focus();
    }
  });

  byId('signUpForm').addEventListener('submit',async(ev)=>{
    ev.preventDefault();
    const msg=byId('signupMsg'),btn=byId('signUpButton');
    const username=byId('signupUsername').value.trim();
    const password=byId('signupPassword').value;
    if(password!==byId('signupConfirm').value){msg.className='msg bad';msg.textContent='Passwords do not match.';return;}
    msg.className='msg';msg.textContent='Creating account...';btn.disabled=true;
    try{
      if(${openSignup}&&!signupChallenge)await loadSignupChallenge();
      const challengeRemainingMs=signupChallenge?Math.max(0,signupChallenge.minAgeMs-(performance.now()-signupChallenge.receivedAt)):0;
      if(challengeRemainingMs>0){
        msg.textContent='Preparing secure signup...';
        await new Promise((resolve)=>setTimeout(resolve,challengeRemainingMs+100));
      }
      const payload={username:username,email:byId('signupEmail').value,password:password,challenge:signupChallenge&&signupChallenge.token};
      const inviteField=byId('signupInvite');
      if(inviteField)payload.invite=inviteField.value;
      const r=await fetch('/signup/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error||'Could not create account.');
      byId('loginUsername').value=username;
      byId('signupPassword').value='';byId('signupConfirm').value='';if(inviteField)inviteField.value='';
      show('signin'); const lm=byId('loginMsg'); lm.className='msg ok'; lm.textContent='Account created. Sign in to continue.';
    }catch(err){msg.className='msg bad';msg.textContent=(err&&err.message)||'Could not create account.';}
    finally{btn.disabled=false;if(${openSignup}){signupChallenge=undefined;loadSignupChallenge().catch(()=>{});}}
  });
})();
</script>
</body></html>`;

const pairPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mecord Connect - Pair Device</title>
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#dbe3ef;--brand:#2563eb;--bg:#f4f7fb;--good:#15803d;--bad:#b91c1c}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 10% 10%,#e8efff 0,transparent 28%),var(--bg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
.card{width:min(520px,100%);background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:24px;padding:34px;box-shadow:0 24px 70px rgba(30,41,59,.14)}
.brand{display:flex;align-items:center;gap:11px;font-weight:850;font-size:18px;margin-bottom:30px}.mark{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#172554,#2563eb);color:white;font-size:13px}
h1{margin:0 0 10px;font-size:30px;letter-spacing:-.035em}.help{color:var(--muted);line-height:1.55;font-size:14px;margin:0 0 24px}.notice{padding:13px 14px;border-radius:12px;background:#eff6ff;color:#1e3a8a;font-size:13px;line-height:1.5;margin-bottom:18px}
label{display:block;font-size:13px;font-weight:750;margin:0 0 7px}input{width:100%;height:50px;border:1px solid var(--line);border-radius:11px;padding:0 14px;font:inherit;text-transform:uppercase;letter-spacing:.08em;outline:none}input:focus{border-color:#7aa2ff;box-shadow:0 0 0 4px rgba(37,99,235,.1)}.choice{display:flex;align-items:flex-start;gap:10px;margin-top:15px;color:#334155;font-size:13px;line-height:1.4}.choice input{width:18px;height:18px;flex:none;margin:1px 0 0;text-transform:none;letter-spacing:normal}.choice label{margin:0;font-weight:600}
button{width:100%;height:48px;border:0;border-radius:10px;background:var(--brand);color:white;font-weight:800;font-size:15px;margin-top:18px;cursor:pointer}button:disabled{opacity:.65;cursor:wait}.msg{min-height:22px;margin-top:12px;font-size:13px;line-height:1.45}.bad{color:var(--bad)}.ok{color:var(--good)}
.foot{margin-top:24px;color:#94a3b8;font-size:11px;text-align:center}
</style></head><body><main class="card">
<div class="brand"><div class="mark">MC</div><span>Mecord Connect</span></div>
<h1>Pair this computer</h1>
<p class="help">Enter the one-time code shown by <strong>mecord-connect remote</strong>. You will authenticate with Mecord before the device is attached to your account.</p>
<div class="notice">Pairing is single-use and short-lived. The browser never receives the relay control credential or your internal Mecord account ID.</div>
<form id="pairForm"><label for="code">Pairing code</label><input id="code" name="code" required maxlength="9" placeholder="ABCD-2345" autocomplete="one-time-code"><div class="choice"><input id="makeDefault" type="checkbox" checked><label for="makeDefault">Use this computer as the default for requests that do not already have a project or device selection.</label></div><button id="pairButton" type="submit">Continue securely</button><div id="pairMsg" class="msg"></div></form>
<div class="foot"><a href="/account">My devices</a> · <button id="pairSwitch" type="button" style="width:auto;height:auto;margin:0;background:transparent;color:#2563eb;padding:0;font-size:11px">Switch account</button><p>Already owned by another user? Release the computer from that account first.</p></div>
</main>
<script>
(function(){
  const input=document.getElementById('code'),makeDefault=document.getElementById('makeDefault'),form=document.getElementById('pairForm'),button=document.getElementById('pairButton'),msg=document.getElementById('pairMsg');
  const q=new URLSearchParams(location.search),prefill=q.get('code');
  document.getElementById('pairSwitch').addEventListener('click',async()=>{
    const button=document.getElementById('pairSwitch');button.disabled=true;
    try{
      const s=await fetch('/account/api/session',{credentials:'same-origin',cache:'no-store'});
      if(!s.ok)throw new Error('Could not validate account session.');
      const data=await s.json();
      if(data.active){
        const cleared=await fetch('/account/logout',{method:'POST',credentials:'same-origin',headers:{'x-mecord-csrf':data.csrf}});
        if(!cleared.ok)throw new Error('Could not clear the previous account session.');
      }
      const r=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({targetURL:'https://auth.splcart.in/signin'})});
      if(!r.ok)throw new Error('Could not sign out.');
      location.assign('/signin?switched=1');
    }catch(e){msg.className='msg bad';msg.textContent=e.message||'Could not switch accounts.';button.disabled=false;}
  });
  if(prefill)input.value=prefill;
  input.addEventListener('input',()=>{let v=input.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);input.value=v.length>4?v.slice(0,4)+'-'+v.slice(4):v;});
  let starting=false;
  async function startPairing(){
    if(starting)return;
    starting=true;button.disabled=true;msg.className='msg';msg.textContent='Opening secure sign-in...';
    try{
      const r=await fetch('/pair/start',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({userCode:input.value,makeDefault:makeDefault.checked})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok||!j.ok||!j.authorizationUrl)throw new Error(j.error||'Pairing could not start.');
      location.assign(j.authorizationUrl);
    }catch(err){starting=false;msg.className='msg bad';msg.textContent=(err&&err.message)||'Pairing could not start.';button.disabled=false;}
  }
  form.addEventListener('submit',async(ev)=>{ev.preventDefault();await startPairing();});
})();
</script></body></html>`;

function pairResultPage(success) {
  const title = success ? 'Device paired' : 'Pairing failed';
  const message = success
    ? 'This computer is now attached to your Mecord account. You can close this page and return to ChatGPT.'
    : 'Pairing failed. If this computer belongs to another account, open My Devices in that account and release it first; then generate a fresh code.';
  const tone = success ? '#15803d' : '#b91c1c';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mecord Connect - ${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;font-family:Inter,system-ui,sans-serif;color:#0f172a;padding:24px}.card{width:min(520px,100%);background:#fff;border:1px solid #e2e8f0;border-radius:22px;padding:36px;box-shadow:0 22px 70px rgba(30,41,59,.12)}.mark{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:#172554;color:#fff;font-weight:850;margin-bottom:24px}h1{font-size:30px;letter-spacing:-.03em;margin:0 0 10px;color:${tone}}p{color:#64748b;line-height:1.6;margin:0}.foot{margin-top:24px;color:#94a3b8;font-size:11px}</style></head><body><main class="card"><div class="mark">MC</div><h1>${title}</h1><p>${message}</p><div class="foot"><a href="/account">My devices</a> · <a href="/pair">Try pairing again</a></div></main></body></html>`;
}

const server = createServer(async (req, res) => {
  try {
    const requestURL = new URL(req.url || '/', 'http://portal.internal');
    const oauthEntry = (requestURL.pathname === '/' || requestURL.pathname === '/consent/openid/decision') && requestURL.searchParams.get('flow') === 'openid_connect';
    if (req.method === 'GET' && (requestURL.pathname === '/signin' || requestURL.pathname === '/signup' || requestURL.pathname === '/recover' || oauthEntry)) {
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && requestURL.pathname === '/account') {
      if (!currentAccountSession(req)) return redirect(res, '/account/start');
      return send(res, 200, accountDashboardPage, 'text/html; charset=utf-8', {
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      });
    }
    if (req.method === 'GET' && requestURL.pathname === '/account/start') {
      if (!pairRateAllowed(clientIp(req))) return send(res, 429, { ok: false, error: 'Too many authorization attempts. Try again later.' });
      const started = pairing.startManagement();
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      const nonce = bindBrowserFlow(state);
      return redirect(res, started.authorizationUrl, browserFlowCookie(nonce, 600));
    }
    if (req.method === 'GET' && requestURL.pathname === '/account/api/session') {
      const session = currentAccountSession(req);
      return send(res, 200, { ok: true, active: Boolean(session), ...(session ? { csrf: session.csrf } : {}) });
    }
    if (req.method === 'GET' && requestURL.pathname === '/account/api/devices') {
      const session = currentAccountSession(req);
      if (!session) return send(res, 401, { ok: false, error: 'SESSION_EXPIRED' });
      const result = await relayAccountRequest(accountListUrl, session.accessToken);
      if (!result.ok) return send(res, result.status, { ok: false, error: result.status === 401 ? 'SESSION_EXPIRED' : 'DEVICE_LIST_UNAVAILABLE' });
      const devices = Array.isArray(result.result.devices) ? result.result.devices : [];
      return send(res, 200, { ok: true, devices, csrf: session.csrf });
    }
    if (req.method === 'POST' && requestURL.pathname === '/account/api/remove') {
      const session = currentAccountSession(req);
      if (!session) return send(res, 401, { ok: false, error: 'SESSION_EXPIRED' });
      if (!accountCsrfAuthorized(req, session)) return send(res, 403, { ok: false, error: 'REQUEST_NOT_AUTHORIZED' });
      const payload = await readJson(req);
      if (typeof payload?.deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.deviceId))
        return send(res, 400, { ok: false, error: 'DEVICE_ID_INVALID' });
      const result = await relayAccountRequest(accountRemoveUrl, session.accessToken, { deviceId: payload.deviceId });
      if (!result.ok) return send(res, result.status, { ok: false, error: 'DEVICE_REMOVE_FAILED' });
      return send(res, 200, { ok: true, status: 'removed' });
    }
    if (req.method === 'POST' && requestURL.pathname === '/account/logout') {
      const session = currentAccountSession(req);
      if (session && !accountCsrfAuthorized(req, session)) return send(res, 403, { ok: false, error: 'REQUEST_NOT_AUTHORIZED' });
      if (!sameOriginPost(req)) return send(res, 403, { ok: false, error: 'REQUEST_NOT_AUTHORIZED' });
      if (session) accountSessions.delete(session.key);
      return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'set-cookie': accountCookie('', 0) });
    }
    if (req.method === 'GET' && requestURL.pathname === '/pair') {
      return send(res, 200, pairPage, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && requestURL.pathname === '/health') {
      return send(res, 200, { ok: true, configured: openSignup || Boolean(inviteHash), signupMode, pairing: true });
    }
    if (req.method === 'GET' && requestURL.pathname === '/signup/challenge' && openSignup) {
      return send(res, 200, issueSignupChallenge(clientIp(req)));
    }
    if (req.method === 'POST' && requestURL.pathname === '/pair/start') {
      const ip = clientIp(req);
      if (!pairRateAllowed(ip)) return send(res, 429, { ok: false, error: 'Too many pairing attempts. Try again later.' });
      const payload = await readJson(req);
      try {
        const started = pairing.start(payload?.userCode, payload?.makeDefault === true);
        return send(res, 200, { ok: true, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt });
      } catch {
        return send(res, 400, { ok: false, error: 'Enter a valid pairing code.' });
      }
    }
    if (req.method === 'GET' && requestURL.pathname === '/pair/callback') {
      const oauthError = requestURL.searchParams.get('error');
      const code = requestURL.searchParams.get('code');
      const state = requestURL.searchParams.get('state');
      if (oauthError || !code || !state) return send(res, 400, pairResultPage(false), 'text/html; charset=utf-8');
      if (pairing.pendingKind(state) === 'management' && !consumeBrowserFlow(req, state)) {
        return send(res, 400, pairResultPage(false), 'text/html; charset=utf-8', { 'set-cookie': browserFlowCookie('', 0) });
      }
      try {
        const completed = await pairing.complete({ code, state });
        if (completed.status === 'management') {
          const session = newAccountSession(completed.accessToken, completed.expiresIn);
          return redirect(res, '/account', [
            accountCookie(session.token, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))),
            browserFlowCookie('', 0)
          ]);
        }
        return send(res, 200, pairResultPage(true), 'text/html; charset=utf-8');
      } catch (error) {
        console.error('[auth-portal] pairing callback failed safely:', error instanceof Error ? error.message : 'UNKNOWN');
        return send(res, 400, pairResultPage(false), 'text/html; charset=utf-8');
      }
    }
    if (req.method === 'POST' && req.url === '/signup/api') {
      const ip = clientIp(req);
      const payload = await readJson(req);
      const run = writeQueue.then(async () => {
        const securityState = await readSecurityState();
        pruneSecurityState(securityState);
        const allowed = rateAllowed(securityState, ip);
        const challengeValid = !openSignup || verifySignupChallenge(payload?.challenge, ip);
        await writeSecurityState(securityState);
        if (!allowed) return { status: 429, body: { ok: false, error: 'Too many attempts. Try again later.' } };
        if (!challengeValid) return { status: 400, body: { ok: false, error: 'Secure signup challenge expired. Refresh and try again.' } };
        return await createUser(payload);
      });
      writeQueue = run.then(() => undefined, () => undefined);
      const result = await run;
      return send(res, result.status, result.body);
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN';
    console.error('[auth-portal]', message);
    return send(res, message === 'BODY_TOO_LARGE' ? 413 : 500, { ok: false, error: 'Account creation failed safely.' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`auth portal listening on :${port}`));
