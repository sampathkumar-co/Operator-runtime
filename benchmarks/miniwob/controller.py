# Source-only extraction of the legacy #359 generic controller.
# No model API, filesystem access, process spawn, CDP connection or benchmark dispatch.
# Run only on independently supplied synthetic observations; host authority remains external.
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
    if type(observation) is not dict or not 1 <= limit <= 125:
        raise ControllerError("OBSERVATION_INVALID")
    ax = observation.get("axtree_object") or {}
    if type(ax) is not dict:
        raise ControllerError("OBSERVATION_INVALID")
    raw = ax.get("nodes") or []
    if type(raw) is not list or len(raw) > 10000:
        raise ControllerError("OBSERVATION_INVALID")
    out: list[dict[str, str]] = []
    known: set[str] = set()
    for node in raw:
        if type(node) is not dict: continue
        bid = node.get("browsergym_id")
        if type(bid) is not str or not re.fullmatch(r"[0-9]{1,6}", bid) or bid in known:
            continue
        role_field, name_field, description_field = (
            node.get("role") or {}, node.get("name") or {}, node.get("description") or {})
        if any(type(field) is not dict for field in (role_field, name_field, description_field)):
            continue
        role, name, description = (
            role_field.get("value", ""), name_field.get("value", ""), description_field.get("value", ""))
        if any(type(v) is not str for v in (role, name, description)):
            continue
        if role in NON_ACTIONABLE: continue
        # Generic and SVG nodes are retained for model visual/DOM grounding.
        if role not in INTERACTIVE and role not in {"generic","SvgRoot","image","img","paragraph","text","group"}: continue
        known.add(bid)
        out.append({"bid":bid,"role":role,"name":name[:130],"description":description[:90]})
        if len(out) >= limit: break
    return out

def observation_digest(goal: str, candidates: list[dict[str,str]], history: list[dict]) -> str:
    return hashlib.sha256(json.dumps([goal,candidates,history[-2:]],sort_keys=True).encode()).hexdigest()[:16]

def normalize_decision(raw: Any, candidates: list[dict[str, str]]) -> Decision:
    """Interpret model output as a suggestion; never grant browser authority."""
    if type(raw) is not dict:
        raise ControllerError("ACTION_NOT_OBJECT")
    name = raw.get("op", raw.get("action"))
    if type(name) is not str or len(name) > 32:
        raise ControllerError("UNSUPPORTED_ACTION")
    op = name.strip().lower().replace("-", "_")
    aliases = {"fill": "set_value", "input": "set_value", "press": "key_press",
               "tap": "click", "sleep": "wait"}
    op = aliases.get(op, op)
    if op not in SUPPORTED:
        raise ControllerError("UNSUPPORTED_ACTION")
    if op == "wait":
        return Decision("wait")
    if type(candidates) is not list or len(candidates) > 125:
        raise ControllerError("OBSERVATION_INVALID")
    ids: set[str] = set()
    for candidate in candidates:
        if type(candidate) is not dict or type(candidate.get("bid")) is not str:
            raise ControllerError("OBSERVATION_INVALID")
        if candidate["bid"] in ids:
            raise ControllerError("OBSERVATION_AMBIGUOUS")
        ids.add(candidate["bid"])
    bid = raw.get("bid", raw.get("id", ""))
    if bid is None:
        bid = ""
    if type(bid) is not str or len(bid) > 64:
        raise ControllerError("UNOBSERVED_OR_AMBIGUOUS_TARGET")
    bid = bid.strip()
    if bid not in ids:
        match = raw.get("target_name", "")
        if type(match) is not str or len(match) > 160:
            raise ControllerError("UNOBSERVED_OR_AMBIGUOUS_TARGET")
        match = match.strip().casefold()
        hits = [candidate["bid"] for candidate in candidates
                if match and type(candidate.get("name")) is str
                and candidate["name"].strip().casefold() == match]
        if len(hits) != 1:
            raise ControllerError("UNOBSERVED_OR_AMBIGUOUS_TARGET")
        bid = hits[0]
    value = raw.get("value", "")
    key = raw.get("key", "")
    if type(value) is not str or type(key) is not str or len(key) > 32:
        raise ControllerError("ACTION_VALUE_INVALID")
    value = value[:400]
    if op in {"type", "set_value", "select"} and not value:
        raise ControllerError("MISSING_VALUE")
    if op == "key_press":
        key = key or "Enter"
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9+_-]{0,31}", key):
            raise ControllerError("KEY_INVALID")
    return Decision(op, bid, value, key)

def model_prompt(goal: str, candidates: list[dict[str,str]], history:list[dict], *, feedback:str="") -> str:
    if type(goal) is not str or type(feedback) is not str or type(history) is not list:
        raise ControllerError("PROMPT_INVALID")
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

def safe_attempt(action: Decision, history: list[dict]) -> bool:
    if type(history) is not list or len(history) > 10000:
        return False
    recent = history[-3:]
    # Uncertain dispatch must be reconciled by the actual provider/kernel;
    # a new model suggestion is never permission for blind replay.
    if any(type(x) is not dict or classify_error(x.get("error", "")) == "stop_uncertain"
           or x.get("sideEffectState") == "uncertain" for x in recent):
        return False
    if action.op == "wait":
        return True
    duplicates = sum(x.get("op") == action.op and x.get("bid") == action.bid
                     and x.get("value") == action.value for x in recent)
    return duplicates < 2

# General CDP DOMSnapshot grounding, applicable to arbitrary DOM/SVG pages.
_ax_observed_candidates = observed_candidates
def observed_candidates(observation: dict[str,Any], *, limit:int=125) -> list[dict[str,str]]:
    result=_ax_observed_candidates(observation,limit=limit)
    snapshot=observation.get("dom_object") or {}
    if type(snapshot) is not dict:return result
    strings=snapshot.get("strings") or []
    if type(strings) is not list or len(strings) > 10000:return result
    def string_at(i):
        return str(strings[i]) if isinstance(i,int) and 0<=i<len(strings) else ""
    documents = snapshot.get("documents") or []
    if type(documents) is not list or len(documents) > 20:
        return result
    for doc in documents:
        if type(doc) is not dict: continue
        nodes=doc.get("nodes") or {}
        if type(nodes) is not dict: continue
        parents=nodes.get("parentIndex") or []
        types=nodes.get("nodeType") or []
        tags=nodes.get("nodeName") or []
        values=nodes.get("nodeValue") or []
        attrs=nodes.get("attributes") or []
        clickable=(nodes.get("isClickable") or {}).get("index") or []
        if not all(type(x) is list and len(x) <= 5000
                   for x in [parents,types,tags,values,attrs,clickable]):continue
        if not (len(parents) == len(types) == len(tags) == len(values) == len(attrs)):
            continue
        def elem_tag(i):
            if type(i) is not int or i<0 or i>=len(tags) or i>=len(types) or types[i]!=1:return ""
            tag=string_at(tags[i]).lower()
            return tag if re.fullmatch(r"[a-z][a-z0-9-]{0,32}",tag) else ""
        def selector(index):
            path=[]
            current=index
            visited=set()
            for _ in range(16):
                if current in visited or type(current) is not int or current<0 or current>=len(parents):
                    return ""
                visited.add(current)
                tag=elem_tag(current)
                if not tag:return ""
                parent=parents[current]
                if type(parent) is not int: return ""
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
                if type(attrs[index]) is not list or len(attrs[index]) > 128: return ""
                for k in range(0,len(attrs[index])-1,2):
                    key=string_at(attrs[index][k])
                    if key in ("aria-label","title","value","placeholder","alt"):
                        pieces.append(string_at(attrs[index][k+1])[:100])
            return " ".join(pieces)[:160]
        for index in clickable:
            if len(result)>=limit:break
            if type(index) is not int or index < 0 or index>=len(types) or types[index]!=1:continue
            css=selector(index)
            if not css:continue
            result.append({"bid":f"dom{index}","role":elem_tag(index),"name":label(index),"description":"DOM-clickable","css":css})
    return result

