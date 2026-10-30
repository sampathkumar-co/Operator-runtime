"""Validate model-reported token usage against pre-call reservations.

This cannot attest provider invoices: it fails closed on incomplete or
incompatible usage and prevents further calls after an observed overrun.
"""
import math

INPUT_USD_PER_MILLION=0.10
OUTPUT_USD_PER_MILLION=0.20

class ModelAccountingError(RuntimeError):
    pass

def checked_reported_usage(usage, *, reservation_usd):
    if (type(usage) is not dict or type(reservation_usd) not in (int,float) or
        not math.isfinite(reservation_usd) or reservation_usd <= 0):
        raise ModelAccountingError("MODEL_ACCOUNTING_INVALID")
    prompt=usage.get("prompt_tokens")
    completion=usage.get("completion_tokens")
    if (type(prompt) is not int or prompt < 1 or
        type(completion) is not int or completion < 0):
        raise ModelAccountingError("MODEL_USAGE_MISSING_OR_INVALID")
    if prompt > 10_000_000 or completion > 100_000:
        raise ModelAccountingError("MODEL_USAGE_IMPLAUSIBLE")
    estimated=(prompt*INPUT_USD_PER_MILLION+completion*OUTPUT_USD_PER_MILLION)/1_000_000
    if estimated > reservation_usd+1e-12:
        raise ModelAccountingError("MODEL_ACCOUNTING_EXCEEDS_RESERVATION")
    return {"prompt_tokens":prompt,"completion_tokens":completion,
            "estimated_usage_usd":estimated,"reserved_usd":reservation_usd,
            "unused_reservation_usd":reservation_usd-estimated}
