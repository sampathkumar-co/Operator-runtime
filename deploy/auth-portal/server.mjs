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
.footer{grid-column:2;text-align:center;color:#94a3b8;font-size:11px;margin:-38px 0 20px}
@media(max-width:820px){body{padding:0;background:#fff}.shell{min-height:100vh;display:block;border:0;border-radius:0}.brand{display:none}.card{padding:34px 22px;min-height:calc(100vh - 48px)}.footer{grid-column:auto;margin:20px}}</style>
</head>
<body><main class="shell">
<div class="brand"><div class="brand-lockup"><div class="mark">MC</div><span>Mecord Connect</span></div><div class="hero-copy"><div class="eyebrow">SECURE DEVICE BRIDGE</div><h1>Your computer, available to ChatGPT.</h1><p>Work with your authorized projects while your device permissions and local policy stay in control.</p></div><div class="hero-proof"><span>✓ Device-scoped access</span><span>✓ Local approval boundary</span><span>✓ One account, multiple devices</span></div></div>
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
<div id="oauthConsentPane" class="pane">
<h2>Connect to ChatGPT</h2><p class="help">Review the access requested for this Mecord Connect session.</p>
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
  let oauthConsent;
  function show(which){
    const login=which==='signin';
    const signup=which==='signup',consent=which==='consent';
    signInTab.classList.toggle('active',login); signUpTab.classList.toggle('active',signup);
    signInPane.classList.toggle('active',login); signUpPane.classList.toggle('active',signup); oauthConsentPane.classList.toggle('active',consent);
    document.querySelector('.tabs').style.display=consent?'none':'grid';
    setTimeout(()=>{ const el=byId(login?'loginUsername':'signupUsername'); if(el) el.focus(); },0);
  }
  signInTab.onclick=()=>show('signin'); signUpTab.onclick=()=>show('signup');
  byId('createInstead').onclick=()=>show('signup'); byId('signinInstead').onclick=()=>show('signin');
  if(location.pathname==='/signup') show('signup');
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
      location.assign('/recover');
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
    const oauthEntry = (requestURL.pathname === '/' || requestURL.pathname === '/consent/openid/decision') && requestURL.searchParams.get('flow') === 'openid_connect';
    if (req.method === 'GET' && (requestURL.pathname === '/signup' || requestURL.pathname === '/recover' || oauthEntry)) {
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
