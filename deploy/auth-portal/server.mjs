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
<title>Mecord Connect â€” Account</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#242424;color:#f7f7f7;display:grid;min-height:100vh;place-items:center}
.shell{width:min(92vw,470px)}
.brand{text-align:center;margin-bottom:20px}.mark{width:68px;height:68px;margin:0 auto 12px;border:2px solid #d7d7d7;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:22px}
.brand h1{margin:0;font-size:28px;font-weight:650}.brand p{margin:7px 0 0;color:#b8b8b8;font-size:14px}
.card{background:#2e2e2e;border:1px solid #454545;border-radius:16px;padding:22px;box-shadow:0 22px 70px #0005}
.tabs{display:grid;grid-template-columns:1fr 1fr;background:#242424;border-radius:10px;padding:4px;margin-bottom:22px}
.tab{margin:0;border:0;border-radius:8px;padding:10px;background:transparent;color:#bbb;font-weight:700;cursor:pointer}
.tab.active{background:#3b3b3b;color:#fff}
.pane{display:none}.pane.active{display:block}
h2{margin:0 0 6px;font-size:22px}p.help{margin:0 0 18px;color:#bcbcbc;font-size:14px;line-height:1.45}
label{display:block;margin:13px 0 6px;font-size:13px;font-weight:700;color:#ddd}
input{width:100%;padding:12px 13px;border-radius:8px;border:1px solid #5a5a5a;background:#272727;color:#fff;font-size:15px;outline:none}
input:focus{border-color:#2889df;box-shadow:0 0 0 2px #2889df33}
.primary{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2385d9;color:#fff;font-weight:800;font-size:15px;cursor:pointer}
.primary:disabled{opacity:.65;cursor:wait}.secondary{background:transparent;border:0;color:#69b6ff;cursor:pointer;font-weight:700;padding:0}
.row{display:flex;align-items:center;gap:8px;margin-top:12px;color:#ccc;font-size:14px}.row input{width:auto}
.msg{min-height:22px;margin-top:12px;font-size:13px;line-height:1.4}.ok{color:#85dfa7}.bad{color:#ffaaaa}
.switch{text-align:center;margin-top:16px;color:#bbb;font-size:13px}
.footer{text-align:center;color:#888;font-size:12px;margin-top:18px}
</style>
</head>
<body><main class="shell">
<div class="brand"><div class="mark">MC</div><h1>Mecord Connect</h1><p>Securely connect ChatGPT to your authorized computer.</p></div>
<section class="card">
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
<h2>Create account</h2><p class="help">Choose your own username and password. You only need the registration code once.</p>
<form id="signUpForm">
<label for="signupUsername">Username</label><input id="signupUsername" autocomplete="username" required placeholder="sampath">
<label for="signupEmail">Email</label><input id="signupEmail" type="email" autocomplete="email" required placeholder="you@example.com">
<label for="signupPassword">Password</label><input id="signupPassword" type="password" autocomplete="new-password" required minlength="12">
<label for="signupConfirm">Confirm password</label><input id="signupConfirm" type="password" autocomplete="new-password" required minlength="12">
<label for="signupInvite">Registration code</label><input id="signupInvite" type="password" autocomplete="one-time-code" required>
<button id="signUpButton" class="primary" type="submit">Create account</button>
<div id="signupMsg" class="msg"></div>
</form>
<div class="switch">Already have an account? <button id="signinInstead" class="secondary" type="button">Sign in</button></div>
</div>
</section>
<div class="footer">Mecord Connect authentication Â· Password sign-in is handled by Authelia</div>
</main>
<script>
(function(){
  const byId=(id)=>document.getElementById(id);
  const signInTab=byId('signInTab'),signUpTab=byId('signUpTab');
  const signInPane=byId('signInPane'),signUpPane=byId('signUpPane');
  function show(which){
    const login=which==='signin';
    signInTab.classList.toggle('active',login); signUpTab.classList.toggle('active',!login);
    signInPane.classList.toggle('active',login); signUpPane.classList.toggle('active',!login);
    setTimeout(()=>{ const el=byId(login?'loginUsername':'signupUsername'); if(el) el.focus(); },0);
  }
  signInTab.onclick=()=>show('signin'); signUpTab.onclick=()=>show('signup');
  byId('createInstead').onclick=()=>show('signup'); byId('signinInstead').onclick=()=>show('signin');
  if(location.pathname==='/signup') show('signup');

  byId('signInForm').addEventListener('submit',async(ev)=>{
    ev.preventDefault();
    const msg=byId('loginMsg'),btn=byId('signInButton');
    msg.className='msg'; msg.textContent='Signing inâ€¦'; btn.disabled=true;
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
      msg.className='msg ok'; msg.textContent='Signed in. Continuingâ€¦';
      byId('loginPassword').value='';
      if(redirect){ location.assign(redirect); return; }
      const next=new URL(location.href);
      next.pathname='/'; next.searchParams.set('auth_native','1');
      location.assign(next.pathname+'?'+next.searchParams.toString());
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
    msg.className='msg';msg.textContent='Creating accountâ€¦';btn.disabled=true;
    try{
      const r=await fetch('/signup/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:username,email:byId('signupEmail').value,password:password,invite:byId('signupInvite').value})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error||'Could not create account.');
      byId('loginUsername').value=username;
      byId('signupPassword').value='';byId('signupConfirm').value='';byId('signupInvite').value='';
      show('signin'); const lm=byId('loginMsg'); lm.className='msg ok'; lm.textContent='Account created. Sign in to continue.';
    }catch(err){msg.className='msg bad';msg.textContent=(err&&err.message)||'Could not create account.';}
    finally{btn.disabled=false;}
  });
})();
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  try {
    const requestURL = new URL(req.url || '/', 'http://portal.internal');
    const oauthEntry = requestURL.pathname === '/' && requestURL.searchParams.get('flow') === 'openid_connect';
    if (req.method === 'GET' && (requestURL.pathname === '/signup' || oauthEntry)) {
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && requestURL.pathname === '/health') {
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
