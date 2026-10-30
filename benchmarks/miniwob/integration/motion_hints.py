"""Advisory motion detection from two fresh observations.

Never predicts a clickable coordinate or grants authority. The provider still
requires a currently observed ref and re-hit-tests the chosen target.
"""
import math

def motion_hints(previous,current):
    if type(previous) is not list or type(current) is not list:
        return []
    def signature(item):
        if type(item) is not dict: return None
        return (item.get("frameTargetId"),item.get("role"),item.get("name"),item.get("description"))
    def unique(items):
        indexed={}
        for item in items[:125]:
            key=signature(item)
            if key is None: continue
            indexed.setdefault(key,[]).append(item)
        return {key:values[0] for key,values in indexed.items() if len(values)==1}
    old,new=unique(previous),unique(current)
    result=[]
    for key,item in new.items():
        earlier=old.get(key)
        if not earlier:continue
        a,b=earlier.get("geometry"),item.get("geometry")
        if type(a) is not dict or type(b) is not dict: continue
        coords=[a.get("x"),a.get("y"),b.get("x"),b.get("y")]
        if any(type(x) not in (int,float) or not math.isfinite(x) for x in coords):continue
        dx,dy=b["x"]-a["x"],b["y"]-a["y"]
        if 3<=math.hypot(dx,dy)<=600 and type(item.get("bid")) is str:
            result.append({"bid":item["bid"],"moved_x":round(dx,1),
                           "moved_y":round(dy,1),"advisory_only":True})
    return result[:12]
