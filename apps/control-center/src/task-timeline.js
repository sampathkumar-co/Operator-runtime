(()=>{"use strict";
function el(tag,cls,text){const item=document.createElement(tag);if(cls)item.className=cls;if(text!==undefined)item.textContent=String(text);return item}
function metric(label,value){const item=el("div","metric");item.append(el("strong","",value),el("span","muted",label));return item}
function micros(value){return Number(value||0).toLocaleString()+" µ"}
function timestamp(value){if(!value)return"Time unavailable";const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString()}
function recovery(model){const box=el("div","callout "+(model.recovery.state==="NONE"?"":"warning"));box.append(el("div","taskTitle","Recovery · "+model.recovery.state.replaceAll("_"," ")),el("div","eventMeta",model.recovery.guidance));if(model.recovery.code)box.append(el("code","timelineCode",model.recovery.code));return box}
function evidenceDetails(items){const details=el("details","timelineEvidence");details.append(el("summary","","Evidence · "+items.length));const list=el("div","timelineEvidenceList");if(!items.length)list.append(el("div","muted","No evidence attached to this event."));for(const item of items){const row=el("div","timelineEvidenceItem "+item.status);row.append(el("span","badge "+item.status.toUpperCase(),item.status),el("strong","",item.kind),el("span","",item.message),el("time","eventMeta",timestamp(item.timestamp)));list.append(row)}details.append(list);return details}
function eventCard(event){const item=el("li","timelineItem");const marker=el("span","timelineMarker");marker.setAttribute("aria-hidden","true");const card=el("article","timelineCard");const head=el("div","taskTop");head.append(el("div","taskTitle",event.title),el("span","badge "+event.state,event.state));card.append(head,el("div","eventMeta",timestamp(event.at)+(event.finishedAt?" → "+timestamp(event.finishedAt):"")));
const facts=[];if(event.attempt!==undefined)facts.push("Attempt "+event.attempt);if(event.risk)facts.push("Risk "+event.risk);if(event.provider)facts.push("Provider "+event.provider);if(facts.length)card.append(el("div","muted",facts.join(" · ")));
if(event.observation)card.append(el("div","timelineObservation","Observed "+event.observation.domain+" via "+event.observation.channel+(event.observation.epistemicStatus?" · "+event.observation.epistemicStatus:"")));
if(event.error){const error=el("div","callout critical");error.append(el("div","taskTitle","Error · "+event.error.code),el("div","eventMeta",event.error.message||[event.error.executionPhase&&"Phase "+event.error.executionPhase,event.error.sideEffectState&&"Side effect "+event.error.sideEffectState].filter(Boolean).join(" · ")||"No execution-phase detail recorded."));card.append(error)}
if(event.kind==="ACTION")card.append(evidenceDetails(event.evidence||[]));item.append(marker,card);return item}
function render(model,loadEarlier){const root=el("section","taskTimeline");root.setAttribute("aria-labelledby","taskTimelineTitle");root.append(el("h3","","Task timeline"));root.lastChild.id="taskTimelineTitle";
const overview=el("div","metricGrid");overview.append(metric("Planner",model.planning.plannerId),metric("Model",model.planning.modelIdentity.status.replaceAll("_"," ")),metric("Verification",model.verification.state),metric("Evidence",model.evidence.total));root.append(overview);
const budget=el("section","timelineBudget");budget.append(el("h4","","Cost and usage"));const reserved=el("div","metricGrid");reserved.append(metric("Reserved calls",model.cost.reserved.calls),metric("Reserved tokens",model.cost.reserved.tokens),metric("Reserved ceiling",micros(model.cost.reserved.ceilingMicros)),metric("Actual cost",model.cost.actual.status.replaceAll("_"," ")));budget.append(reserved,el("p","muted",model.cost.actual.reason),el("p","muted",model.planning.modelIdentity.reason));root.append(budget,recovery(model));
const evidence=el("div","timelineEvidenceSummary");evidence.append(el("span","badge PASS","Pass "+model.evidence.pass),el("span","badge FAIL","Fail "+model.evidence.fail),el("span","badge INFO","Info "+model.evidence.info));root.append(evidence);if(model.evidence.truncated)root.append(el("p","muted","Evidence status counts cover "+model.evidence.classified.toLocaleString()+" of "+model.evidence.total.toLocaleString()+" items; the projection is bounded."));
const list=el("ol","timelineList");for(const event of model.timeline||[])list.append(eventCard(event));
if(model.page&&model.page.nextBefore!==null&&typeof loadEarlier==="function"){
  const controls=el("div","timelineHistoryControls");
  const button=el("button","btn","Load earlier actions");button.type="button";
  const message=el("span","muted","");
  let cursor=model.page.nextBefore;
  button.addEventListener("click",async()=>{
    if(!Number.isSafeInteger(cursor)||cursor<1||button.disabled)return;
    button.disabled=true;message.textContent="Loading earlier history...";
    try{
      const earlier=await loadEarlier(cursor,model.page.snapshot);
      if(!earlier||!earlier.page||earlier.page.snapshot!==model.page.snapshot||
        !Array.isArray(earlier.timeline)||
        (earlier.page.nextBefore!==null&&(!Number.isSafeInteger(earlier.page.nextBefore)||earlier.page.nextBefore>=cursor)))
        throw new Error("History cursor is stale; refresh this task to continue.");
      const fragment=document.createDocumentFragment();
      for(const event of earlier.timeline)fragment.append(eventCard(event));
      // Keep the already-visible task creation marker at the beginning.
      list.insertBefore(fragment,list.children[1]||null);
      cursor=earlier.page.nextBefore;
      if(cursor===null)controls.remove();
      message.textContent="";
    }catch(error){message.textContent=error instanceof Error?error.message:"Earlier history could not be loaded.";}
    finally{button.disabled=false;}
  });
  controls.append(button,message);root.append(controls);
}else if(model.truncated){
  root.append(el("div","callout warning","Only the newest actions are shown; earlier history is not available in this view."));
}
root.append(list);return root}
window.MecordTaskTimeline=Object.freeze({render});
})();
