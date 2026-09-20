import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { Algorithm, hash as argon2Hash } from '@node-rs/argon2';
import YAML from 'yaml';

const port = Number(process.env.PORT || 8090);
const usersFile = process.env.PORTAL_USERS_FILE || '/data/users_database.yml';
const inviteHash = (process.env.PORTAL_INVITE_SHA256 || '').trim().toLowerCase();
const defaultGroup = process.env.PORTAL_DEFAULT_GROUP || 'operator-users';
const maxBody = 16 * 1024;
const attempts = new Map();
let writeQueue = Promise.resolve();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY'
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

function rateAllowed(ip) {
  const now = Date.now();
  const item = attempts.get(ip) || { count: 0, reset: now + 15 * 60_000 };
  if (now > item.reset) {
    item.count = 0;
    item.reset = now + 15 * 60_000;
  }
  item.count += 1;
  attempts.set(ip, item);
  return item.count <= 8;
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
  if (!validInvite(invite)) {
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
<title>Create Operator account</title>
<style>
body{margin:0;font-family:Inter,system-ui,sans-serif;background:#0b1020;color:#eef2ff;display:grid;min-height:100vh;place-items:center}
.card{width:min(92vw,460px);background:#111831;border:1px solid #26304f;border-radius:22px;padding:28px;box-shadow:0 24px 80px #0007}
h1{margin:0 0 8px;font-size:28px}p{color:#aeb8d4;line-height:1.5}
label{display:block;margin:16px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:12px;border:1px solid #33405f;background:#0a1124;color:white;font-size:15px}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:12px;background:#fff;color:#111831;font-weight:800;font-size:15px;cursor:pointer}
#msg{min-height:24px;margin-top:14px}.ok{color:#7ee2a8}.bad{color:#ff9a9a}.small{font-size:13px}
</style>
</head>
<body><main class="card">
<h1>Create your Operator account</h1>
<p>Choose the username and password you want. No server editing is needed.</p>
<form id="f">
<label>Username</label><input id="u" autocomplete="username" required placeholder="sampath">
<label>Email</label><input id="e" type="email" autocomplete="email" required placeholder="you@example.com">
<label>Password</label><input id="p" type="password" autocomplete="new-password" required minlength="12">
<label>Confirm password</label><input id="c" type="password" autocomplete="new-password" required minlength="12">
<label>Registration code</label><input id="i" type="password" autocomplete="one-time-code" required>
<button>Create account</button><div id="msg" class="small"></div>
</form>
<script>
const f=document.getElementById('f'),m=document.getElementById('msg');
f.addEventListener('submit',async e=>{e.preventDefault();m.className='small';m.textContent='Creating account…';
if(p.value!==c.value){m.className='small bad';m.textContent='Passwords do not match.';return}
try{const r=await fetch('/signup/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,email:e.value,password:p.value,invite:i.value})});
const j=await r.json();m.className='small '+(r.ok?'ok':'bad');m.textContent=r.ok?'Account created. You can sign in now.':(j.error||'Could not create account.');
if(r.ok){p.value='';c.value='';i.value=''}}catch{m.className='small bad';m.textContent='Could not reach the account service.'}});
</script>
</main></body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/signup') {
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, configured: Boolean(inviteHash) });
    }
    if (req.method === 'POST' && req.url === '/signup/api') {
      const forwardedIp = String(req.headers['x-real-ip'] || '').trim();
      const ip = forwardedIp || req.socket.remoteAddress || 'unknown';
      if (!rateAllowed(ip)) return send(res, 429, { ok: false, error: 'Too many attempts. Try again later.' });
      const payload = await readJson(req);
      const run = writeQueue.then(() => createUser(payload));
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
