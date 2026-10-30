"""Read-only, observation-proven pagination for the isolated MiniWoB bridge.

A model may request the next observed page but cannot invent the offsets.
Never combine stale generation-bound refs from different inspect calls.
"""
def next_page_offsets(pagination, *, current_control=0, current_visual=0):
    if not isinstance(pagination, dict):
        return None
    out = {}
    advanced = False
    for key, current, name in (("controls", current_control, "controlOffset"),
                               ("visualObjects", current_visual, "visualOffset")):
        meta=pagination.get(key)
        if not isinstance(meta, dict):
            return None
        if type(current) is not int or not 0 <= current <= 640:
            return None
        if meta.get("truncated") is True:
            next_offset=meta.get("nextOffset")
            if type(next_offset) is not int or not current < next_offset <= 640:
                return None
            out[name]=next_offset
            advanced = True
        else:
            out[name]=current
    return out if advanced else None
