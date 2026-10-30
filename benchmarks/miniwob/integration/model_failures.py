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


def classify_episode_failure(exc):
    """Return (kind, unscored, campaign_stop), without leaking exception text.

    Only independently scored controller mistakes and timeouts count toward
    task failure. All execution, billing, model-transport, or harness
    uncertainties stop the campaign and remain unscored.
    """
    import urllib.error
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return ("MODEL_TRANSPORT", True, "MODEL_TRANSPORT_UNCERTAIN")
    msg = str(exc)
    if (is_campaign_blocking_meta_failure(msg) or
        msg.startswith(("META_HTTP_", "MODEL_USAGE_", "MODEL_ACCOUNTING_",
                        "BUDGET_", "VISION_RESERVATION_"))):
        return ("MODEL_PROVIDER_OR_BILLING", True, "MODEL_PROVIDER_OR_BILLING_STOP")
    if (is_campaign_blocking_execution_failure(msg) or
        msg.startswith(("BRIDGE_", "PROVIDER_", "NO_MECORD_", "MECORD_",
                        "LOCAL_BRIDGE_", "SCREENSHOT_", "NATIVE_RUNTIME_",
                        "PAGINATION_NOT_AVAILABLE"))):
        return ("MECORD_INFRASTRUCTURE", True, "MECORD_INFRASTRUCTURE_STOP")
    if msg.startswith("MODEL_RESPONSE_") or type(exc).__name__ == "MecordObservationError":
        return ("MODEL_DECISION", False, None)
    if msg == "TASK_WALL_TIMEOUT":
        return ("TASK_TIMEOUT", False, None)
    return ("HARNESS_OR_UNKNOWN", True, "HARNESS_UNEXPECTED_FAILURE")
