// Account management UI intentionally contains no OAuth secrets or bearer tokens.
export const accountDashboardPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>My Devices — Mecord Connect</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#111d36;background:#f6f8fd}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(145deg,#f7f9ff 10%,#eff4fc 65%,#f8fbff 100%);font-size:14px}
button,a{font:inherit}a{color:inherit;text-decoration:none}button{cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}
:focus-visible{outline:3px solid #80aaff;outline-offset:3px}
.shell{display:grid;grid-template-columns:254px minmax(0,1fr);min-height:100vh}
.sidebar{padding:34px 22px;background:#0d1932;color:#f8fbff;display:flex;flex-direction:column;gap:40px}
.brand{display:flex;align-items:center;gap:12px;font-size:17px;font-weight:800;letter-spacing:-.03em;padding:0 9px}
.logo{display:grid;place-items:center;width:40px;height:40px;border-radius:13px;background:#3971f0;color:white;font-size:13px;letter-spacing:-.06em;box-shadow:0 5px 18px #102d7855}
.nav{display:grid;gap:7px}.nav a{display:flex;gap:12px;align-items:center;padding:13px 15px;border-radius:12px;color:#aebfdf;font-weight:650}
.nav a.active,.nav a:hover{background:#ffffff18;color:#fff}.nav a span{font-size:18px}
.sidefoot{margin-top:auto;background:#ffffff0b;border:1px solid #ffffff15;border-radius:16px;padding:19px;color:#d3e0fa;font-size:12px;line-height:1.6}
.sidefoot strong{color:white;display:block;margin-bottom:6px;font-size:13px}
.main{min-width:0;padding:38px clamp(22px,5vw,72px) 80px;max-width:1400px;width:100%;margin:auto}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #e4e9f4;padding-bottom:26px;margin-bottom:36px}
.breadcrumb{font-size:13px;color:#76839b;font-weight:650}.breadcrumb b{color:#263755}.topactions{display:flex;gap:10px;flex-wrap:wrap}
.btn{padding:11px 16px;border:1px solid #d7e0ed;border-radius:11px;background:white;color:#273850;font-weight:750;box-shadow:0 2px 5px #25335708}
.btn:hover{background:#f1f5ff}.btn.primary{background:#285ee7;border-color:#285ee7;color:#fff}.btn.primary:hover{background:#1e4bd1}
.btn.danger{color:#bc364e;border-color:#f3d5dc}.btn.danger:hover{background:#fff3f5}
.head{display:flex;gap:20px;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;margin-bottom:29px}
.eyebrow{color:#2f69df;font-size:11px;font-weight:850;letter-spacing:.13em;text-transform:uppercase;margin:0 0 12px}
h1{font-size:clamp(30px,4vw,42px);letter-spacing:-.055em;margin:0 0 12px;line-height:1.1}
.lead{margin:0;color:#64748b;font-size:15px;max-width:610px;line-height:1.7}
.stat{background:#fff;border:1px solid #e1e7f2;border-radius:18px;padding:20px 25px;min-width:152px;box-shadow:0 14px 35px #2645770a}
.stat span{display:block;font-size:12px;color:#748299;font-weight:650;margin-bottom:8px}.stat strong{font-size:28px;letter-spacing:-.06em}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:0 0 18px;flex-wrap:wrap}
.toolbar h2{font-size:19px;letter-spacing:-.035em;margin:0}.toolbar p{margin:5px 0 0;color:#8390a5;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:17px}
.device{background:#fff;border:1px solid #dfe7f1;border-radius:19px;padding:22px;box-shadow:0 12px 29px #18274709;min-width:0}
.deviceheader{display:flex;align-items:flex-start;gap:14px;margin-bottom:19px}
.deviceicon{width:48px;height:48px;display:grid;place-items:center;background:#eef4ff;color:#3564dc;border-radius:13px;font-size:23px;flex:none}
.deviceheader h3{margin:1px 0 8px;font-size:16px;letter-spacing:-.025em;overflow-wrap:anywhere}.tag{display:inline-flex;padding:4px 9px;background:#eaf8f2;color:#15836b;border-radius:99px;font-size:11px;font-weight:800}
.detail{padding:15px 0;border-top:1px solid #eef1f6;color:#73819a;font-size:12px;line-height:1.7}
.detail strong{color:#40516d;font-weight:700;overflow-wrap:anywhere}.devicefooter{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:9px}
.info{padding:19px 22px;background:#edf4ff;border:1px solid #d7e6ff;border-radius:17px;color:#3d5476;line-height:1.65;margin-top:28px;font-size:13px}
.info strong{color:#1d407f}.status{padding:24px;border:1px dashed #cbd6e9;border-radius:18px;color:#63748f;background:#fff;font-size:14px;line-height:1.6}
.error{color:#b42339;background:#fff4f5;border-color:#f3b8c1}
.dialogshade{position:fixed;inset:0;background:#0a1736aa;display:grid;place-items:center;padding:20px;z-index:10}
.dialogshade[hidden]{display:none}.dialog{width:min(460px,100%);padding:28px;border-radius:20px;background:white;box-shadow:0 34px 80px #0003}
.dialog h2{font-size:23px;letter-spacing:-.04em;margin:0 0 10px}.dialog p{color:#62728e;line-height:1.6;margin:0 0 20px}
.dialogbuttons{display:flex;gap:10px;justify-content:flex-end}
#flash{margin-bottom:18px}#flash[hidden]{display:none}
@media(max-width:800px){.shell{grid-template-columns:1fr}.sidebar{padding:15px 18px;gap:13px}.brand{padding:0}.nav{display:flex;flex-wrap:wrap}.nav a{padding:8px 10px}.sidefoot{display:none}.main{padding:28px 18px 50px}.top{padding-bottom:18px;margin-bottom:30px}.grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){.btn,.nav a{transition:background .16s ease}}
</style></head>
<body><div class="shell"><aside class="sidebar">
<div class="brand"><div class="logo">MC</div>Mecord Connect</div>
<nav class="nav" aria-label="Account navigation"><a class="active" href="/account" aria-current="page"><span>▦</span> My devices</a><a href="/pair"><span>＋</span> Pair computer</a><a href="/signin"><span>↗</span> Sign in</a></nav>
<div class="sidefoot"><strong>Designed for your control</strong>Devices remain under local permissions and approval rules. Disconnecting a computer revokes its remote access, without deleting files on that computer.</div>
</aside><main class="main">
<header class="top"><div class="breadcrumb">Account <span aria-hidden="true">/</span> <b>My devices</b></div><div class="topactions"><button id="switch" class="btn" type="button">Switch account</button><button id="logout" class="btn" type="button">Log out</button></div></header>
<section class="head"><div><p class="eyebrow">Secure workspace</p><h1>My devices</h1><p class="lead">Review computers linked to your Mecord account, pair a new one or securely release one you no longer use.</p></div><div class="stat"><span>Paired computers</span><strong id="deviceCount">—</strong></div></section>
<div id="flash" role="status" aria-live="polite" hidden></div>
<section aria-label="Paired computers"><div class="toolbar"><div><h2>Connected to your account</h2><p>Paired devices may be offline; this is an ownership list, not a live connection indicator.</p></div><div class="topactions"><button class="btn" id="refresh" type="button">↻ Refresh</button><a class="btn primary" href="/pair">+ Pair computer</a></div></div>
<div id="devices" class="grid" aria-live="polite"><div class="status">Loading the devices authorized for this account…</div></div></section>
<div class="info"><strong>Switching accounts?</strong> A device cannot belong to two active Mecord accounts. First release it from its existing account here; then start <a href="/pair"><u>fresh pairing</u></a> from the new account. Logging out does not disconnect devices or revoke ChatGPT OAuth access.</div>
</main></div>
<div class="dialogshade" id="dialogShade" hidden><section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialogTitle" aria-describedby="dialogDescription"><h2 id="dialogTitle">Release this computer?</h2><p id="dialogDescription"></p><div class="dialogbuttons"><button class="btn" id="cancelRemove" type="button">Cancel</button><button class="btn danger" id="confirmRemove" type="button">Release device</button></div></section></div>
<script>
(function(){
  const el=(id)=>document.getElementById(id);
  let csrf='', devices=[], removing=null, busy=false;
  function notice(message,error=false){const node=el('flash');node.hidden=false;node.className='status'+(error?' error':'');node.textContent=message;}
  async function load(){
    el('refresh').disabled=true;
    try{
      const response=await fetch('/account/api/devices',{credentials:'same-origin',cache:'no-store'});
      const data=await response.json().catch(()=>({}));
      if(response.status===401){location.assign('/account/start');return;}
      if(!response.ok||!data.ok||!Array.isArray(data.devices))throw new Error('Device list is temporarily unavailable. Try refreshing.');
      csrf=data.csrf;devices=data.devices;render();
    }catch(e){el('devices').replaceChildren();const box=document.createElement('div');box.className='status error';box.textContent=e.message||'Could not load devices.';el('devices').appendChild(box);}
    finally{el('refresh').disabled=false;}
  }
  function render(){
    const root=el('devices');root.replaceChildren();el('deviceCount').textContent=String(devices.length);
    if(!devices.length){const empty=document.createElement('div');empty.className='status';empty.textContent='No paired computers yet. Select “Pair computer” to attach one securely.';root.appendChild(empty);return;}
    for(const device of devices){
      const card=document.createElement('article');card.className='device';
      const header=document.createElement('div');header.className='deviceheader';
      const icon=document.createElement('div');icon.className='deviceicon';icon.setAttribute('aria-hidden','true');icon.textContent='▣';
      const info=document.createElement('div');const name=document.createElement('h3');name.textContent=device.deviceName||'Unnamed computer';const tag=document.createElement('span');tag.className='tag';tag.textContent='Paired';info.append(name,tag);header.append(icon,info);
      const detail=document.createElement('div');detail.className='detail';
      const id=document.createElement('div');id.textContent='Device ID: ';const idText=document.createElement('strong');idText.textContent=device.deviceId;id.appendChild(idText);
      const date=document.createElement('div');date.textContent='Added: '+(device.addedAt ? new Date(device.addedAt).toLocaleString():'Unknown');
      detail.append(id,date);
      const footer=document.createElement('div');footer.className='devicefooter';
      const note=document.createElement('span');note.className='detail';note.textContent='Account-bound access';
      const release=document.createElement('button');release.className='btn danger';release.type='button';release.textContent='Release';release.onclick=()=>askRelease(device);
      footer.append(note,release);card.append(header,detail,footer);root.appendChild(card);
    }
  }
  function askRelease(device){removing=device;el('dialogDescription').textContent='Revoke remote access for “'+(device.deviceName||device.deviceId)+'”? This cannot be undone without pairing again. Local files are not deleted.';el('dialogShade').hidden=false;el('cancelRemove').focus();}
  function close(){if(busy)return;removing=null;el('dialogShade').hidden=true;}
  el('cancelRemove').onclick=close;
  document.addEventListener('keydown',(e)=>{if(e.key==='Escape')close();});
  el('confirmRemove').onclick=async()=>{
    if(!removing||busy)return;busy=true;el('confirmRemove').disabled=true;el('confirmRemove').textContent='Releasing…';
    try{
      const r=await fetch('/account/api/remove',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-mecord-csrf':csrf},body:JSON.stringify({deviceId:removing.deviceId})});
      const data=await r.json().catch(()=>({}));
      if(r.status===401){location.assign('/account/start');return;}
      if(!r.ok||!data.ok)throw new Error('Device could not be released. It may already have been removed.');
      el('dialogShade').hidden=true;notice('Device released. Re-pair it from the new owning account if needed.');
      await load();
    }catch(e){notice(e.message||'Release failed.',true);}
    finally{busy=false;removing=null;el('confirmRemove').disabled=false;el('confirmRemove').textContent='Release device';}
  };
  el('refresh').onclick=load;
  async function signOut(){
    if(busy)return;busy=true;
    try{
      const response=await fetch('/account/api/session',{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('Could not verify the account session.');
      const session=await response.json();
      const local=await fetch('/account/logout',{method:'POST',credentials:'same-origin',headers:{'x-mecord-csrf':session.csrf||csrf}});
      if(!local.ok)throw new Error('Portal session could not be cleared.');
      const remote=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({targetURL:'https://auth.splcart.in/signin'})});
      if(!remote.ok)throw new Error('Your portal session ended, but the sign-in session could not be cleared. Retry logout before switching accounts.');
      location.replace('/signin?logged_out=1');
    }catch(e){notice(e.message||'Logout failed. Please retry.',true);busy=false;}
  }
  el('switch').onclick=signOut;el('logout').onclick=signOut;
  load();
})();
</script></body></html>`;
