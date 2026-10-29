"""Source-only projection of current Mecord browser.inspect observations for MiniWoB.

No model/network/filesystem access. Never converts a model answer into CSS or
grants authority; the isolated host bridge must independently validate refs.
"""
from __future__ import annotations
import re
from typing import Any
from controller import ControllerError, Decision, normalize_decision, safe_attempt

REF = re.compile(r"b-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+")
MAX_CONTROLS = 125
class MecordObservationError(ValueError):
    pass

def observed_mecord_candidates(payload: dict[str, Any], limit: int = 90) -> list[dict[str, Any]]:
    """Projection only; bridge verifies same target/ref/generation before dispatch."""
    if type(payload) is not dict or payload.get("ok") is not True or payload.get("provider") != "browser.cdp":
        raise MecordObservationError("INSPECTION_NOT_VERIFIED")
    if type(limit) is not int or not 1 <= limit <= MAX_CONTROLS:
        raise MecordObservationError("INVALID_LIMIT")
    page = payload.get("page")
    if type(page) is not dict or type(page.get("semantic")) is not dict:
        raise MecordObservationError("SEMANTIC_OBSERVATION_UNAVAILABLE")
    semantic = page["semantic"]
    generation = semantic.get("observationGeneration")
    if type(generation) is not str or not re.fullmatch(r"[a-z0-9]+-[a-z0-9]+", generation):
        raise MecordObservationError("INVALID_OBSERVATION_GENERATION")
    if type(semantic.get("controls")) is not list or type(semantic.get("visuals")) is not list:
        raise MecordObservationError("OBSERVATION_LISTS_MISSING")
    if len(semantic["controls"]) > 1000 or len(semantic["visuals"]) > 1000:
        raise MecordObservationError("OBSERVATION_LISTS_OVERSIZE")
    seen = set()
    candidates = []
    for category, objects in (("semantic", semantic["controls"]), ("visual", semantic["visuals"])):
        for item in objects:
            if len(candidates) >= limit:
                return candidates
            if type(item) is not dict or item.get("disabled") is True:
                continue
            # SVG primitives are geometry-grounded, but may not have DOM
            # "actionable" semantics. They are NOT ordinary click targets.
            visual_relative = (
                category == "visual" and item.get("actionable") is not True
                and item.get("tag") in {"text","circle","ellipse","rect","path","polygon","polyline","line"}
            )
            if item.get("actionable") is not True and not visual_relative:
                continue
            ref = item.get("ref")
            if type(ref) is not str or REF.fullmatch(ref) is None or not ref.startswith("b-" + generation + "-") or ref in seen:
                continue
            context = item.get("context")
            if type(context) is not dict or context.get("frameDepth") != 0:
                continue
            rect = item.get("geometry") or item.get("rect")
            if type(rect) is not dict:
                continue
            x,y,w,h = (rect.get(k) for k in ("x","y","width","height"))
            if any(type(v) not in (float,int) or not (-100000 < v < 100000) for v in (x,y,w,h)) or w <= 0 or h <= 0:
                continue
            role = item.get("role") or item.get("primitive") or item.get("tag") or "visual"
            perceptible = item.get("perceptibleState")
            if type(perceptible) is not dict: perceptible = {}
            name = item.get("name") or perceptible.get("text") or ""
            if type(role) is not str or type(name) is not str:
                continue
            seen.add(ref)
            candidates.append({
                "bid":ref,"role":role[:40],"name":name[:130],
                "description":"visual-geometry" if visual_relative else category,
                "geometry":{"x":round(x,1),"y":round(y,1),"width":round(w,1),"height":round(h,1)},
            })
    return candidates

def verified_action(raw: object, candidates: list[dict[str,Any]], history: list[dict]) -> dict[str,str]:
    """Normalize a model suggestion; permit only exact, currently observed refs."""
    relative = type(raw) is dict and raw.get("op") == "click_relative"
    if relative:
        proposal = dict(raw)
        proposal["op"] = "click"
    else:
        proposal = raw
    try:
        action = normalize_decision(proposal, candidates)
    except ControllerError as exc:
        raise MecordObservationError(str(exc)) from None
    if action.op == "wait":
        if not safe_attempt(action,history):
            raise MecordObservationError("UNCERTAIN_HISTORY")
        return {"op":"wait"}
    if action.op not in {"click","hover","set_value","type","select","key_press"}:
        raise MecordObservationError("OPERATION_NOT_SUPPORTED")
    match = [c for c in candidates if c.get("bid") == action.bid]
    if len(match) != 1:
        raise MecordObservationError("UNOBSERVED_TARGET")
    if relative:
        if match[0].get("description") != "visual-geometry":
            raise MecordObservationError("RELATIVE_TARGET_NOT_VISUAL")
        action = Decision("click_relative", action.bid, action.value, action.key)
    elif match[0].get("description") == "visual-geometry":
        raise MecordObservationError("VISUAL_NEEDS_RELATIVE_CLICK")
    if not safe_attempt(action,history):
        raise MecordObservationError("UNSAFE_REPLAY")
    return {"op":action.op,"ref":action.bid,"value":action.value,"key":action.key}
