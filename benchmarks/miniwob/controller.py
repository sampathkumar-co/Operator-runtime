"""Model-agnostic observed-action controller for authorized synthetic browsers.

This module does NOT embed MiniWoB task names, answers, or privileged shortcuts.
Every action must be grounded in the current browser observation and preexisting authority.
"""
from __future__ import annotations
import json
import hashlib
import re
from dataclasses import dataclass
from typing import Any

SUPPORTED = {"click", "hover", "set_value", "type", "select", "key_press", "wait"}
INTERACTIVE = {"button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
               "option", "listbox", "spinbutton", "slider", "menuitem", "tab", "switch"}
NON_ACTIONABLE = {"StaticText", "InlineTextBox", "LineBreak", "none", "RootWebArea"}

class ControllerError(ValueError): pass

@dataclass(frozen=True)
class Decision:
    op: str
    bid: str = ""
    value: str = ""
    key: str = ""

def observed_candidates(observation: dict[str, Any], *, limit: int = 125) -> list[dict[str, str]]:
    raw = (observation.get("axtree_object") or {}).get("nodes") or []
    out: list[dict[str, str]] = []
    known: set[str] = set()
    for node in raw:
        if not isinstance(node, dict): continue
        bid = str(node.get("browsergym_id") or "")
        if not bid.isdecimal() or len(bid) > 6 or bid in known: continue
        role = str((node.get("role") or {}).get("value") or "")
        if role in NON_ACTIONABLE: continue
        name = str((node.get("name") or {}).get("value") or "")
        description = str((node.get("description") or {}).get("value") or "")
        # Generic and SVG nodes are retained for model visual/DOM grounding.
        if role not in INTERACTIVE and role not in {"generic","SvgRoot","image","img","paragraph","text","group"}: continue
        known.add(bid)
        out.append({"bid":bid,"role":role,"name":name[:130],"description":description[:90]})
        if len(out) >= limit: break
    return out

def observation_digest(goal: str, candidates: list[dict[str,str]], history: list[dict]) -> str:
    return hashlib.sha256(json.dumps([goal,candidates,history[-2:]],sort_keys=True).encode()).hexdigest()[:16]

def normalize_decision(raw: Any, candidates: list[dict[str,str]]) -> Decision:
    if not isinstance(raw,dict): raise ControllerError("ACTION_NOT_OBJECT")
    op = str(raw.get("op") or raw.get("action") or "").strip().lower().replace("-","_")
    aliases = {"fill":"set_value","input":"set_value","press":"key_press","tap":"click","sleep":"wait"}
    op = aliases.get(op,op)
    if op not in SUPPORTED: raise ControllerError("UNSUPPORTED_ACTION")
    if op=="wait": return Decision("wait")
    bid=str(raw.get("bid") if raw.get("bid") is not None else raw.get("id") or "").strip()
    ids={item["bid"] for item in candidates}
    if bid not in ids:
        # Resolve an exact, unique, observation-grounded accessible name; never guess IDs.
        match=str(raw.get("target_name") or "").strip()
        hits=[item["bid"] for item in candidates if match and item["name"].strip().casefold()==match.casefold()]
        if len(hits)!=1: raise ControllerError("UNOBSERVED_OR_AMBIGUOUS_TARGET")
        bid=hits[0]
    value=str(raw.get("value") or "")[:400]
    key=str(raw.get("key") or "")[:32]
    if op in {"type","set_value","select"} and not value:
        raise ControllerError("MISSING_VALUE")
    if op=="key_press" and not key: key="Enter"
    return Decision(op,bid,value,key)

def model_prompt(goal: str, candidates: list[dict[str,str]], history:list[dict], *, feedback:str="") -> str:
    if len(goal)>1300:goal=goal[:1300]
    return (
        "You control a NEW synthetic web page using Mecord's verified browser tools. "
        "Choose ONE next action, or wait if content is loading. "
        "Use the exact element bid from CURRENT candidates, including DOM-grounded IDs. Do not invent bids. "
        "Return only a JSON object with fields op,bid,value,key,target_name. "
        "Supported ops: click,hover,set_value,type,select,key_press,wait. "
        "For clicking use op=click; for typing a value into textbox use op=set_value. "
        "For a multi-step goal, plan the next step based on prior actions and feedback. "
        "Do not claim completion: the environment independently verifies completion. "
        "If there are generic or SvgRoot elements, they may require graphical grounding; "
        "never assume they represent a particular button without observation. "
        f"\nGoal: {goal}\nCurrent candidate elements: "
        + json.dumps(candidates,ensure_ascii=True)[:14000]
        + "\nPrevious actions/results: " + json.dumps(history[-5:],ensure_ascii=True)[:3500]
        + "\nFeedback: "+feedback[:800]
    )

def classify_error(code: str) -> str:
    code=str(code or "").upper()
    if "UNCERTAIN" in code or "RECONCIL" in code: return "stop_uncertain"
    if "APPROVAL" in code or "POLICY" in code or "AUTHORITY" in code: return "stop_authority"
    if "STALE" in code or "ELEMENT_NOT_FOUND" in code or "NO_PROGRESS" in code: return "reobserve"
    if "INTERACTION_FAILED" in code: return "reobserve_no_replay"
    return "fail"

def safe_attempt(action:Decision, history:list[dict]) -> bool:
    if action.op=="wait": return True
    recent=history[-3:]
    duplicates=sum(x.get("op")==action.op and x.get("bid")==action.bid and x.get("value")==action.value for x in recent)
    return duplicates<2

# General CDP DOMSnapshot grounding, applicable to arbitrary DOM/SVG pages.
_ax_observed_candidates = observed_candidates
def observed_candidates(observation: dict[str,Any], *, limit:int=125) -> list[dict[str,str]]:
    result=_ax_observed_candidates(observation,limit=limit)
    snapshot=observation.get("dom_object") or {}
    if not isinstance(snapshot,dict):return result
    strings=snapshot.get("strings") or []
    if not isinstance(strings,list):return result
    def string_at(i):
        return str(strings[i]) if isinstance(i,int) and 0<=i<len(strings) else ""
    for doc in (snapshot.get("documents") or []):
        nodes=doc.get("nodes") or {}
        parents=nodes.get("parentIndex") or []
        types=nodes.get("nodeType") or []
        tags=nodes.get("nodeName") or []
        values=nodes.get("nodeValue") or []
        attrs=nodes.get("attributes") or []
        clickable=(nodes.get("isClickable") or {}).get("index") or []
        if not all(isinstance(x,list) for x in [parents,types,tags,values,attrs,clickable]):continue
        def elem_tag(i):
            if i<0 or i>=len(tags) or i>=len(types) or types[i]!=1:return ""
            tag=string_at(tags[i]).lower()
            return tag if re.fullmatch(r"[a-z][a-z0-9-]{0,32}",tag) else ""
        def selector(index):
            path=[]
            current=index
            for _ in range(16):
                if current<0 or current>=len(parents):return ""
                tag=elem_tag(current)
                if not tag:return ""
                parent=parents[current]
                siblings=[i for i,par in enumerate(parents) if par==parent and elem_tag(i)==tag]
                rank=siblings.index(current)+1
                path.append(f"{tag}:nth-of-type({rank})")
                if parent<0 or not elem_tag(parent):break
                current=parent
            if len(path)>14:return ""
            return " > ".join(reversed(path))
        def label(index):
            pieces=[]
            for j in range(len(values)):
                if len(pieces)>=12:break
                if j!=index and (j>=len(parents) or parents[j]!=index):continue
                if j<len(types) and types[j]==3:
                    txt=string_at(values[j]).strip()
                    if txt:pieces.append(txt[:100])
            if not pieces:
                for k in range(0,len(attrs[index])-1,2):
                    key=string_at(attrs[index][k])
                    if key in ("aria-label","title","value","placeholder","alt"):
                        pieces.append(string_at(attrs[index][k+1])[:100])
            return " ".join(pieces)[:160]
        for index in clickable:
            if len(result)>=limit:break
            if not isinstance(index,int) or index>=len(types) or types[index]!=1:continue
            css=selector(index)
            if not css:continue
            result.append({"bid":f"dom{index}","role":elem_tag(index),"name":label(index),"description":"DOM-clickable","css":css})
    return result

