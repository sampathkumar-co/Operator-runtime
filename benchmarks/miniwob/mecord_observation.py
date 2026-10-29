"""Source-only projection of current Mecord browser.inspect observations for MiniWoB.

No model/network/filesystem access. Never converts a model answer into CSS or
grants authority; the isolated host bridge must independently validate refs.
"""
from __future__ import annotations
import re
import json
from hashlib import sha256
from datetime import date
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
    # Keep a visual reservation instead of allowing the first 90 controls to
    # crowd every graphical target out of the model's view.
    first_controls = max(1, limit * 2 // 3)
    ordered = ([("semantic", item) for item in semantic["controls"][:first_controls]]
               + [("visual", item) for item in semantic["visuals"]]
               + [("semantic", item) for item in semantic["controls"][first_controls:]])
    for category, item in ordered:
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
        # Sortable DOM children and scrollable regions can be observed
        # without having ordinary button actionability. They receive only
        # their matching specialist actions, never arbitrary clicks.
        sortable = (category=="visual" and item.get("actionable") is not True
                    and item.get("groupRole")=="li"
                    and "sortable" in str(item.get("semanticPath") or "").casefold()
                    and item.get("tag") in {"div","li","span"})
        scrollable = item.get("scrollable") is True
        if item.get("actionable") is not True and not (visual_relative or sortable or scrollable):
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
            "description":("visual-geometry" if visual_relative else
                           "sortable-geometry" if sortable else
                           "scroll-geometry" if scrollable and item.get("actionable") is not True else category),
            "scrollable": scrollable,
            "editable": item.get("editable") is True,
            "checked": item.get("checked") if type(item.get("checked")) is bool else None,
            "selected": item.get("selected") if type(item.get("selected")) is bool else None,
            "expanded": item.get("expanded") if type(item.get("expanded")) is bool else None,
            "currentValue": item.get("value")[:160] if type(item.get("value")) is str else "",
            "placeholder": item.get("placeholder")[:100] if type(item.get("placeholder")) is str else "",
            "identity": sha256(json.dumps([
                str(role).casefold(), name[:130].casefold(),
                item.get("groupRole") if type(item.get("groupRole")) is str else "",
                item.get("semanticPath") if type(item.get("semanticPath")) is str else "",
                item.get("repeatedOrdinal") if type(item.get("repeatedOrdinal")) is int else None,
                round(x / 32), round(y / 32)
            ], ensure_ascii=True).encode()).hexdigest()[:20],
            "inputType": item.get("type") if type(item.get("type")) is str else "",
            "geometry":{"x":round(x,1),"y":round(y,1),"width":round(w,1),"height":round(h,1)},
        })
    return candidates

def verified_action(raw: object, candidates: list[dict[str,Any]], history: list[dict]) -> dict[str,str]:
    """Normalize a model suggestion; permit only exact, currently observed refs."""
    # Do not use accessible-name fallback to turn an invented/stale model ID
    # into authority. A proposed action must name one exact CURRENT Mecord ref.
    if type(raw) is not dict:
        raise MecordObservationError("ACTION_NOT_OBJECT")
    if set(raw) - {"op","bid","value","key"}:
        raise MecordObservationError("UNSUPPORTED_MODEL_FIELDS")
    if raw.get("op") == "wait":
        if raw.get("bid", "") != "" or raw.get("value", "") != "" or raw.get("key", "") != "":
            raise MecordObservationError("WAIT_MUST_HAVE_NO_TARGET")
        if (not safe_attempt(Decision("wait"), history) or any(
                type(h) is not dict or h.get("sideEffectState") == "uncertain"
                or (type(h.get("error")) is str and any(x in h["error"].upper() for x in ("UNCERTAIN","RECONCIL")))
                for h in history)):
            raise MecordObservationError("UNCERTAIN_HISTORY")
        return {"op": "wait"}
    ref = raw.get("bid")
    if type(ref) is not str or REF.fullmatch(ref) is None:
        raise MecordObservationError("EXACT_OBSERVED_REF_REQUIRED")
    if type(candidates) is not list or sum(
            type(c) is dict and c.get("bid") == ref for c in candidates) != 1:
        raise MecordObservationError("EXACT_OBSERVED_REF_REQUIRED")
    relative = raw.get("op") == "click_relative"
    date_action = raw.get("op") == "select_date"
    scroll_action = raw.get("op") == "scroll"
    drag_action = raw.get("op") == "drag_between"
    extended = {"drag_by", "resize", "hotkey", "keyboard_text", "format_text", "select_text_range"}
    if relative or date_action or scroll_action or drag_action or raw.get("op") in extended:
        proposal = dict(raw)
        proposal["op"] = "set_value" if date_action or raw.get("op") in {"keyboard_text","format_text","select_text_range"} else "click"
    elif raw.get("op") == "set_value" and raw.get("value") == "":
        proposal = dict(raw)
        proposal["value"] = " "  # Generic normalizer forbids clear-to-empty; benchmark permits it.
    else:
        proposal = raw
    try:
        action = normalize_decision(proposal, candidates)
    except ControllerError as exc:
        raise MecordObservationError(str(exc)) from None
    if raw.get("op") == "set_value" and raw.get("value") == "":
        action = Decision("set_value", action.bid, "", action.key)
    if action.op not in {"click","hover","set_value","type","select","key_press"}:
        raise MecordObservationError("OPERATION_NOT_SUPPORTED")
    match = [c for c in candidates if c.get("bid") == action.bid]
    if len(match) != 1:
        raise MecordObservationError("UNOBSERVED_TARGET")
    chosen = match[0]
    role = str(chosen.get("role") or "").casefold()
    editable_roles = {"textbox","searchbox","combobox","spinbutton","input","textarea"}
    select_roles = {"select","combobox","listbox","option"}
    if action.op in {"set_value","type"} and not date_action and not (
            chosen.get("editable") is True or role in editable_roles
            or (action.op == "set_value" and role == "slider")):
        raise MecordObservationError("TARGET_NOT_EDITABLE")
    if action.op == "select" and role not in select_roles:
        raise MecordObservationError("TARGET_NOT_SELECTABLE")
    if scroll_action:
        if chosen.get("scrollable") is not True or re.fullmatch(r"(up|down)(:(80|160|320))?", str(raw.get("value"))) is None:
            raise MecordObservationError("SCROLL_TARGET_OR_DIRECTION_INVALID")
        action=Decision("scroll", action.bid, raw["value"], "")
    if drag_action:
        to_ref=raw.get("value")
        other=[c for c in candidates if c.get("bid")==to_ref]
        if (chosen.get("description")!="sortable-geometry"
                or len(other)!=1 or other[0].get("description")!="sortable-geometry"
                or action.bid==to_ref
                or action.bid.rsplit("-",1)[0]!=to_ref.rsplit("-",1)[0]):
            raise MecordObservationError("DRAG_TARGETS_NOT_CURRENT_SORTABLE")
        action=Decision("drag_between",action.bid,to_ref,"")
    if raw.get("op") in {"drag_by", "resize"}:
        if re.fullmatch(r"(left|right|up|down):(40|80|160)", str(raw.get("value"))) is None:
            raise MecordObservationError("DISPLACEMENT_INVALID")
        action = Decision(raw["op"], action.bid, raw["value"], "")
    if raw.get("op") in {"keyboard_text", "format_text", "select_text_range"}:
        if not (chosen.get("editable") is True or role in editable_roles):
            raise MecordObservationError("TARGET_NOT_EDITABLE")
        if raw["op"] == "format_text" and raw.get("value") not in {"bold","italic","underline"}:
            raise MecordObservationError("FORMAT_INVALID")
        if raw["op"] == "select_text_range":
            match_range = re.fullmatch(r"(0|[1-9][0-9]{0,3}):(0|[1-9][0-9]{0,3})", str(raw.get("value")))
            if not match_range or int(match_range[1]) > int(match_range[2]):
                raise MecordObservationError("TEXT_RANGE_INVALID")
        action = Decision(raw["op"], action.bid, action.value, "")
    if raw.get("op") == "hotkey":
        if raw.get("key") not in {"CTRL+A","CTRL+C","CTRL+V","CTRL+Z","CTRL+SHIFT+Z","CTRL+B","CTRL+I","CTRL+U"}:
            raise MecordObservationError("HOTKEY_INVALID")
        action = Decision("hotkey", action.bid, "", raw["key"])
    if date_action:
        if chosen.get("inputType") != "date":
            raise MecordObservationError("DATE_TARGET_NOT_DATE_INPUT")
        try:
            if len(action.value) != 10 or date.fromisoformat(action.value).isoformat() != action.value:
                raise ValueError("invalid date")
        except ValueError:
            raise MecordObservationError("DATE_VALUE_INVALID") from None
        action = Decision("select_date", action.bid, action.value, action.key)
    if relative:
        if match[0].get("description") != "visual-geometry":
            raise MecordObservationError("RELATIVE_TARGET_NOT_VISUAL")
        action = Decision("click_relative", action.bid, action.value, action.key)
    elif match[0].get("description") == "visual-geometry" and raw.get("op") not in {"drag_by","resize"}:
        raise MecordObservationError("VISUAL_NEEDS_RELATIVE_CLICK")
    if not relative and not date_action and not scroll_action and not drag_action and raw.get("op") not in {"drag_by","resize"} and chosen.get("description") in {"sortable-geometry","scroll-geometry"}:
        raise MecordObservationError("SPECIALIST_ACTION_REQUIRED")
    # Detect uncertainty throughout this bounded task, not only the last 3
    # entries checked by the generic source controller.
    if type(history) is not list or len(history) > 1000:
        raise MecordObservationError("HISTORY_INVALID")
    if any(type(h) is not dict or h.get("sideEffectState") == "uncertain"
           or (type(h.get("error")) is str and
               ("UNCERTAIN" in h["error"].upper() or "RECONCIL" in h["error"].upper()))
           for h in history):
        raise MecordObservationError("UNCERTAIN_HISTORY")
    # Generation-bound refs are new after every inspect, so comparing only bid
    # cannot catch repeated actions against the same unchanged physical target.
    stable_identity = chosen.get("identity")
    if stable_identity and sum(
        h.get("identity") == stable_identity and h.get("op") == action.op
        and h.get("value", "") == action.value
        for h in history[-4:] if type(h) is dict
    ) >= 2:
        raise MecordObservationError("UNSAFE_REPLAY_STABLE_TARGET")
    if not safe_attempt(action,history):
        raise MecordObservationError("UNSAFE_REPLAY")
    return {"op":action.op,"ref":action.bid,"value":action.value,"key":action.key}
