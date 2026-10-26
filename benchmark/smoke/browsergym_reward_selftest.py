import json
import gymnasium as gym
import browsergym.miniwob  # registers MiniWoB environments

TASK = "browsergym/miniwob.click-test"

env = gym.make(TASK)
try:
    obs, info = env.reset(seed=0)
    props = obs.get("extra_element_properties", {})
    candidates = []
    for bid, meta in props.items():
        if not isinstance(meta, dict):
            continue
        if meta.get("clickable") is not True:
            continue
        bbox = meta.get("bbox")
        visibility = meta.get("visibility")
        if not bbox:
            continue
        candidates.append((bid, visibility if isinstance(visibility, (int, float)) else -1.0))

    if not candidates:
        raise RuntimeError("No clickable BrowserGym bid was exposed by click-test.")

    # click-test exposes a single actionable control. Prefer the most visible
    # clickable BID; this is a harness/scorer self-test, not an agent policy.
    candidates.sort(key=lambda item: (-item[1], item[0]))
    target_bid = candidates[0][0]
    action = f"click({target_bid!r})"

    obs2, reward, terminated, truncated, info2 = env.step(action)

    result = {
        "ok": bool(reward > 0 and (terminated or truncated)),
        "task": TASK,
        "action": action,
        "reward": float(reward),
        "terminated": bool(terminated),
        "truncated": bool(truncated),
        "lastActionError": str(obs2.get("last_action_error", "")),
        "clickableCandidateCount": len(candidates),
    }
    print(json.dumps(result, sort_keys=True))

    if not result["ok"]:
        raise RuntimeError(f"BrowserGym scorer self-test failed: {result}")
finally:
    env.close()
