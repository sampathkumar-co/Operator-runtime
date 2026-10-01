import json
import time
import gymnasium as gym
import browsergym.miniwob  # registers BrowserGym MiniWoB environments

TASK = "browsergym/miniwob.click-test"

started = time.perf_counter()
env = gym.make(TASK)
try:
    obs, info = env.reset(seed=0)
    elapsed_ms = (time.perf_counter() - started) * 1000
    goal = obs.get("goal") if isinstance(obs, dict) else None
    print(json.dumps({
        "ok": True,
        "task": TASK,
        "resetMs": round(elapsed_ms, 3),
        "goalPresent": bool(goal),
        "observationKeys": sorted(list(obs.keys())) if isinstance(obs, dict) else [],
        "infoKeys": sorted(list(info.keys())) if isinstance(info, dict) else []
    }, sort_keys=True))
finally:
    env.close()
