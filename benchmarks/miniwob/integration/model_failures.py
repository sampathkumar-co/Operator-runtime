"""Sanitized Meta HTTP classification, with no provider message or prompt logging."""
import json
import re

def safe_meta_http_error(status, raw=b""):
    code=int(status)
    detail=""
    try:
        payload=json.loads(raw[:4096]) if isinstance(raw,bytes) else {}
        error=payload.get("error",{}) if type(payload) is dict else {}
        if type(error) is dict:
            for key in ("code","type"):
                v=error.get(key)
                if type(v) is str and re.fullmatch(r"[A-Za-z0-9_.-]{1,48}",v):
                    detail=v
                    break
    except (ValueError,UnicodeError):
        pass
    return f"META_HTTP_{code}" + (f"_{detail}" if detail else "")

def is_campaign_blocking_meta_failure(value):
    if type(value) is not str:
        return False
    match=re.match(r"^META_HTTP_([0-9]{3})(?:_|$)",value)
    if match is None:
        return False
    status=int(match.group(1))
    return status in {400,401,403,408,422,429} or 500 <= status <= 599


def is_campaign_blocking_execution_failure(value):
    """Provider/observation failures may have unknown browser side effects.

    Do not equate a dispatch failure with an independently scored zero reward.
    """
    if type(value) is not str:
        return False
    return value.startswith((
        "MECORD_EXECUTION_",
        "MECORD_OBSERVATION_FAILED",
        "MECORD_VISION_UNAVAILABLE",
        "LOCAL_BRIDGE_TRANSPORT_",
        "NATIVE_RUNTIME_CAPABILITY_CHANGED",
    ))
