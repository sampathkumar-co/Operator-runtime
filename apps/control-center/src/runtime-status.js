(()=>{"use strict";
const diagnostics=document.getElementById("diagnostics");
const list=document.getElementById("diagnosticList");
if(!diagnostics||!list)return;
const region=document.createElement("section");
region.id="runtimeStatusSummary";
region.className="runtimeStatus";
region.setAttribute("aria-labelledby","runtimeStatusTitle");
const title=document.createElement("h3");
title.id="runtimeStatusTitle";
title.textContent="Runtime status";
const body=document.createElement("div");
body.className="muted";
body.setAttribute("role","status");
body.setAttribute("aria-live","polite");
body.textContent="Sign in to load source and capability status.";
region.append(title,body);
diagnostics.insertBefore(region,list);
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node}
function duration(ms){const seconds=Math.max(0,Math.floor(Number(ms||0)/1000));const days=Math.floor(seconds/86400);const hours=Math.floor(seconds%86400/3600);const minutes=Math.floor(seconds%3600/60);return(days?days+"d ":"")+(hours?hours+"h ":"")+minutes+"m"}
function render(status){body.replaceChildren();const grid=el("div","metricGrid");grid.append(
el("div","metric",""),el("div","metric",""),el("div","metric",""),el("div","metric","")
);const metrics=[
[status.product.runtimeVersion,"Runtime version"],
[status.product.compatibility,"Package compatibility"],
[duration(status.uptimeMs),"Uptime"],
[status.relay.state,"Relay · "+status.relay.freshness]
];[...grid.children].forEach((node,index)=>node.append(el("strong","",metrics[index][0]),el("span","muted",metrics[index][1])));
body.append(grid);
const source=el("div","callout");source.append(el("div","taskTitle",status.product.sourceIdentity==="KNOWN"?"Source "+status.product.sourceCommit:"Source commit unavailable"),el("div","eventMeta",status.product.packageVersion?"Package "+status.product.packageVersion:"Package identity unavailable in this development runtime"));source.append(el("div","eventMeta",status.relay.sourceCommit?"Relay server source "+status.relay.sourceCommit+" | Relay source compatibility "+status.relay.sourceCompatibility:"Relay server source unverified; no source parity claim."));body.append(source);
if(status.relay.freshness==="STALE"||status.product.compatibility==="MISMATCH"||status.relay.sourceCompatibility==="MISMATCH"){const warning=el("div","callout warning");warning.append(el("div","taskTitle","Runtime attention required"),el("div","eventMeta",status.relay.freshness==="STALE"?"Relay status has not changed for more than five minutes; refresh or inspect connectivity before relying on it.":status.relay.sourceCompatibility==="MISMATCH"?"Local runtime and relay server source commits differ; verify the deployment before acting.":"Installed package and runtime versions do not match."));body.append(warning)}
const details=el("details","runtimeCapabilities");const summary=el("summary","","Supported capabilities · "+status.capabilities.count);details.append(summary);const names=el("div","capabilityList");for(const name of status.capabilities.names)names.append(el("code","",name));details.append(names);body.append(details);
const configured=(status.configuration.optionalFeatures||[]).filter(item=>item.configured).map(item=>item.name);body.append(el("div","eventMeta","Authorized roots: "+status.configuration.authorizedRootCount+" · Configured optional features: "+(configured.length?configured.join(", "):"none")))}
// Multiple network polls can settle out of order. A superseded successful
// response must never redraw private runtime status after a newer 401/logout.
let latestStatusRequest=0;
async function refreshStatus(){
const requestId=++latestStatusRequest;
try{
const response=await fetch("/v1/control-center/status",{credentials:"same-origin",cache:"no-store"});
if(requestId!==latestStatusRequest)return;
if(response.status===401){body.replaceChildren();body.textContent="Sign in to load source and capability status.";return}
const payload=await response.json();
if(requestId!==latestStatusRequest)return;
if(!response.ok||!payload.status)throw new Error("status unavailable");
render(payload.status)
}catch{
if(requestId===latestStatusRequest){body.replaceChildren();body.textContent="Runtime status is temporarily unavailable; other dashboard panels may be stale."}
}
}
void refreshStatus();const timer=setInterval(refreshStatus,2500);window.addEventListener("mecord:signout",()=>{latestStatusRequest++;body.replaceChildren();body.textContent="Sign in to load source and capability status."});window.addEventListener("beforeunload",()=>{latestStatusRequest++;clearInterval(timer)});
})();
