"""Conservative HTTP bridge failure decoding, independent of BrowserGym/Meta."""
def parse_bridge_http_rejection(status, detail):
    reason = detail.get("error") if type(detail) is dict else None
    safe = (status == 400 and type(detail) is dict
            and detail.get("executionPhase") == "pre_dispatch"
            and detail.get("sideEffectState") == "none")
    return {"ok":False,"provider":None,
            "error":("BRIDGE_HTTP_"+str(status)+"_"+str(reason or "UNKNOWN"))[:110],
            "executionPhase":"pre_dispatch" if safe else None,
            "sideEffectState":"none" if safe else None}
