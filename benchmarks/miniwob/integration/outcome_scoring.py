"""Independent terminal reward for a task that never reached BrowserGym.step."""
import math

def score_terminal_if_unstepped(outcome, env):
    if not isinstance(outcome,dict):
        raise ValueError("INVALID_EPISODE")
    if outcome.get("unscored") is True or outcome.get("reward") is None:
        return False
    if outcome.get("steps") != 0:
        return False
    if env is None:
        raise ValueError("BROWSERGYM_ENV_NOT_INITIALIZED")
    _,reward,done,truncated,_=env.step("noop()")
    if type(reward) not in (int,float) or not math.isfinite(reward) or reward not in (0,1):
        raise ValueError("BROWSERGYM_REWARD_INVALID")
    outcome["steps"]=1
    outcome["reward"]=float(reward)
    outcome.setdefault("trace",[]).append({"terminal_noop_reward":float(reward),
        "episode_done":bool(done or truncated)})
    return True
