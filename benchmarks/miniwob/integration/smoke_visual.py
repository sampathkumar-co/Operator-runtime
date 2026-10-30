"""No-model, no-credential MiniWoB / Mecord RC6 browser integration smoke.

This is an explicit scripted test of the plumbing, NOT an AI benchmark score.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error
import secrets
from pathlib import Path
from playwright.sync_api._generated import BrowserType

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mecord_observation import observed_mecord_candidates, verified_action

workdir = os.environ.get("MECORD_MINIWOB_WORKDIR")
chrome = os.environ.get("MECORD_MINIWOB_CHROME")
if not workdir or not chrome or not Path(chrome).is_file():
    raise RuntimeError("ISOLATED_WORKDIR_AND_CHROME_REQUIRED")
root = Path(workdir).resolve(strict=True)
os.environ["MINIWOB_URL"] = (root / "miniwob-plusplus" / "miniwob" / "html" / "miniwob").as_uri() + "/"
os.environ["MECORD_BENCH_CDP_PORT"] = "9330"
import gymnasium as gym
import browsergym.miniwob

if len([x for x in gym.envs.registry if x.startswith("browsergym/miniwob.")]) != 125:
    raise RuntimeError("MINIWOB_REGISTRY_MISMATCH")

_original_launch = BrowserType.launch
def isolated_chrome(self, *pos, **kwargs):
    flags = list(kwargs.get("args") or [])
    kwargs["executable_path"] = chrome
    if "ignore_default_args" in kwargs:
        flags += ["--remote-debugging-port=9330", "--remote-debugging-address=127.0.0.1"]
    kwargs["args"] = flags
    return _original_launch(self, *pos, **kwargs)

def request(port, body):
    req = urllib.request.Request("http://127.0.0.1:" + str(port) + "/execute",
                                 data=json.dumps(body).encode(),method="POST",
                                 headers={"Content-Type":"application/json",
                                 "Authorization":"Bearer "+bridge_token})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

env = None
bridge = None
bridge_token = secrets.token_hex(32)
BrowserType.launch = isolated_chrome
try:
    env = gym.make("browsergym/miniwob.click-test",headless=True)
    observation, _ = env.reset(seed=42)
    bridge_env=dict(os.environ)
    bridge_env["MECORD_MINIWOB_BRIDGE_TOKEN"]=bridge_token
    bridge=subprocess.Popen(["node",str(Path(__file__).with_name("mecord_bridge.mjs"))],
                            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                            env=bridge_env,text=True)
    header = bridge.stdout.readline().strip()
    if not header.startswith("MECORD_BRIDGE_PORT="):
        raise RuntimeError("BRIDGE_FAILED_TO_START")
    port = int(header.split("=",1)[1])
    # The bridge must refuse all unauthenticated local HTTP requests.
    unsigned = urllib.request.Request(
        "http://127.0.0.1:"+str(port)+"/execute",
        data=b'{"op":"inspect"}',method="POST",
        headers={"Content-Type":"application/json"})
    try:
        urllib.request.urlopen(unsigned,timeout=5)
        raise RuntimeError("BRIDGE_ACCEPTED_UNAUTHENTICATED_REQUEST")
    except urllib.error.HTTPError as exc:
        if exc.code != 403:raise
    inspect = request(port,{"op":"inspect","visual":True})
    if inspect.get("screenshotStatus") != "READY" or not inspect.get("screenshot"):
        raise RuntimeError("SCREENSHOT_SMOKE_FAILED_" + str(inspect.get("screenshotStatus"))[:90])
    if len(str(inspect.get("screenshotSha256") or "")) != 64:
        raise RuntimeError("SCREENSHOT_DIGEST_INVALID")
    candidates = observed_mecord_candidates(inspect)
    buttons = [c for c in candidates if c["role"]=="button" and c["name"]=="Click Me!"]
    if len(buttons) != 1:
        raise RuntimeError("SMOKE_TARGET_NOT_UNIQUE")
    action = verified_action({"op":"click","bid":buttons[0]["bid"]},candidates,[])
    dispatched = request(port,{"op":action["op"],"ref":action["ref"]})
    if dispatched.get("ok") is not True or dispatched.get("provider")!="browser.cdp":
        raise RuntimeError("MECORD_DISPATCH_NOT_VERIFIED")
    # A dispatched ref is single-use until the next fresh observation.
    try:
        request(port,{"op":action["op"],"ref":action["ref"]})
        raise RuntimeError("BRIDGE_REPLAY_ACCEPTED")
    except urllib.error.HTTPError as exc:
        if exc.code != 400:raise
    observation,reward,done,truncated,_ = env.step("noop()")
    if float(reward) != 1.0 or done is not True:
        raise RuntimeError("BROWSERGYM_INDEPENDENT_REWARD_NOT_PROVEN")
    print("ISOLATED_RC6_MINIWOB_SMOKE_PASS " + json.dumps({
        "roster":125,"task":"browsergym/miniwob.click-test",
        "seed":42,"score":float(reward),"model_calls":0,
        "mecord_provider":dispatched.get("provider"),
        "mecord_action_ms":dispatched.get("durationMs")
    }), flush=True)
finally:
    if bridge:
        bridge.terminate()
        try: bridge.wait(timeout=5)
        except subprocess.TimeoutExpired: bridge.kill()
    if env: env.close()
    BrowserType.launch = _original_launch
