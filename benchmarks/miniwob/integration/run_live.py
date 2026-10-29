"""Reproducible synthetic MiniWoB: Meta Muse -> Mecord browser.cdp -> BrowserGym reward.
No public relay, no personal browsing, no secret output. Task selection is systematic.
"""
import os, json, re, time, argparse, subprocess, urllib.request, urllib.error, sys
from pathlib import Path
from hashlib import sha256
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
workspace = os.environ.get("MECORD_MINIWOB_WORKDIR")
if not workspace:raise RuntimeError("ISOLATED_WORKDIR_REQUIRED")
B = Path(workspace).resolve(strict=True)
source_commit=subprocess.run(["git","-C",str(B/"miniwob-plusplus"),"rev-parse","HEAD"],
    capture_output=True,text=True,check=True).stdout.strip()
if source_commit!="7fd85d71a4b60325c6585396ec4f48377d049838":
    raise RuntimeError("MINIWOB_SOURCE_NOT_PINNED")
CHROME_EXE = os.environ.get("MECORD_MINIWOB_CHROME")
if not CHROME_EXE or not Path(CHROME_EXE).is_file():
    raise RuntimeError("BENCHMARK_CHROME_EXECUTABLE_REQUIRED")
if not os.environ.get("MECORD_MINIWOB_RUNTIME_PATH"):
    raise RuntimeError("ISOLATED_MECORD_RUNTIME_PATH_REQUIRED")
arg = argparse.ArgumentParser()
arg.add_argument("--limit", type=int, default=12)
arg.add_argument("--worker", type=int, default=0)
arg.add_argument("--workers", type=int, default=1)
arg.add_argument("--max-steps", type=int, default=4)
arg.add_argument("--cap-usd", type=float, default=0.20)
arg.add_argument("--seed", type=int, default=42)
arg.add_argument("--task-id", type=str, default=None)
args = arg.parse_args()
assert 1 <= args.limit <= 125 and 1 <= args.workers <= 4
assert 0 <= args.worker < args.workers and 1 <= args.max_steps <= 10
assert 0.001 <= args.cap_usd <= 0.075
cdp_port = 9330 + args.worker
os.environ["MECORD_BENCH_CDP_PORT"] = str(cdp_port)
os.environ["MINIWOB_URL"] = (B / "miniwob-plusplus" / "miniwob" / "html" / "miniwob").as_uri() + "/"
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(Path.home() / "AppData" / "Local" / "ms-playwright")
import gymnasium as gym
import browsergym.miniwob
from mecord_observation import observed_mecord_candidates,verified_action,MecordObservationError
from playwright.sync_api._generated import BrowserType

# Isolated process-only shim: BrowserGym supplies launch args itself, and also
# starts a separate chat window with default executable selection. Scope the
# CDP port to the task browser, and use the installed Chrome for both windows.
_ORIGINAL_LAUNCH = BrowserType.launch
def _rc6_test_chrome_launch(self, *positionals, **kwargs):
    task_browser = "ignore_default_args" in kwargs
    args_list = list(kwargs.get("args") or [])
    kwargs["executable_path"] = CHROME_EXE
    if task_browser:
        args_list.extend([f"--remote-debugging-port={cdp_port}", "--remote-debugging-address=127.0.0.1"])
    kwargs["args"] = args_list
    return _ORIGINAL_LAUNCH(self, *positionals, **kwargs)

BrowserType.launch = _rc6_test_chrome_launch

key = os.environ.get("MUSE_API_KEY","")
if not key:raise RuntimeError("MUSE_API_KEY_REQUIRED_FROM_HOST_ENV")
if not 16 <= len(key) <= 400:
    raise RuntimeError("META_KEY_INVALID")

all_tasks = sorted(str(t) for t in gym.envs.registry if str(t).startswith("browsergym/miniwob."))
assert len(all_tasks) == 125, len(all_tasks)
indices = (list(range(125)) if args.limit == 125 else
           [round(i * 124 / (args.limit - 1)) for i in range(args.limit)] if args.limit > 1 else [0])
task_plan = [(i, all_tasks[index]) for i, index in enumerate(indices) if i % args.workers == args.worker]
if args.task_id:
    if args.task_id not in all_tasks:
        raise RuntimeError("TASK_ID_NOT_IN_FROZEN_BROWSERGYM_ROSTER")
    task_plan = [(all_tasks.index(args.task_id), args.task_id)]
cost = 0.0
in_tokens = 0
out_tokens = 0
api_calls = 0
max_out_tokens = 2048
output_dir = B / "results"
output_dir.mkdir(parents=True, exist_ok=True)
case_label = (args.task_id.split(".")[-1] if args.task_id else f"{args.limit}")
output_path = output_dir / f"meta_rc6_grounded_portable_{case_label}_seed{args.seed}_worker{args.worker}of{args.workers}.jsonl"
if output_path.exists():
    raise RuntimeError("RESULTS_ALREADY_EXIST_REFUSE_OVERWRITE")
bridge = subprocess.Popen(["node", "--experimental-strip-types", str(Path(__file__).with_name("mecord_bridge.mjs"))],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          text=True, bufsize=1)
JSON_ACTION_SCHEMA = {
    "type":"json_schema",
    "json_schema":{"name":"mecord_browser_action","strict":True,"schema":{
        "type":"object","properties":{
            "op":{"type":"string","enum":["click","set_value","type","select","key_press","hover","click_relative"]},
            "bid":{"type":"string"},"value":{"type":"string"},"key":{"type":"string"}
        },
        "required":["op","bid","value","key"],"additionalProperties":False
    }}
}
def request_model(prompt):
    global cost,in_tokens,out_tokens,api_calls
    reserve = ((len(prompt)/1.0)*0.10+max_out_tokens*0.20)/1e6
    if cost+reserve>args.cap_usd:raise RuntimeError("BUDGET_CAP_REACHED")
    payload={"model":"muse-spark-1.3-contributor",
             "messages":[{"role":"user","content":prompt}],
             "response_format":JSON_ACTION_SCHEMA,
             "max_tokens":max_out_tokens}
    req=urllib.request.Request("https://api.meta.ai/v1/chat/completions",
                               data=json.dumps(payload).encode(),method="POST",
                               headers={"Authorization":"Bearer "+key,"Content-Type":"application/json"})
    for retry in range(2):
        try:
            with urllib.request.urlopen(req,timeout=55) as r:data=json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code in (429,503) and retry==0:
                time.sleep(3)
                continue
            raise RuntimeError("META_HTTP_"+str(e.code))
    u=data.get("usage") or {}
    ti=int(u.get("prompt_tokens") or 0);to=int(u.get("completion_tokens") or 0)
    in_tokens+=ti;out_tokens+=to;api_calls+=1
    cost+=(ti*.10+to*.20)/1e6
    choices=data.get("choices") or []
    if not choices:return {}, "incomplete"
    choice=choices[0]
    content=(choice.get("message") or {}).get("content") or ""
    if not isinstance(content,str):return {}, "incomplete"
    try:action=json.loads(content)
    except json.JSONDecodeError:return {}, "incomplete"
    return action if isinstance(action,dict) else {}, ("completed" if choice.get("finish_reason")=="stop" else "truncated" if choice.get("finish_reason")=="length" else "incomplete")

def compact_nodes(obs):
    allowed = {"button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
               "option", "listbox", "spinbutton", "slider", "menuitem", "tab", "switch"}
    items = []
    seen = set()
    for node in (obs.get("axtree_object") or {}).get("nodes") or []:
        bid = str(node.get("browsergym_id") or "")
        role = str((node.get("role") or {}).get("value") or "")
        if not bid.isdigit() or role not in allowed or bid in seen: continue
        seen.add(bid)
        name = str((node.get("name") or {}).get("value") or "")[:130]
        items.append({"bid": bid, "role": role, "name": name})
    return items[:90]

def bridge_call(port, payload):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/execute", data=json.dumps(payload).encode(),
                                 method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=21) as response:
        return json.load(response)

try:
    header = bridge.stdout.readline().strip()
    if not header.startswith("MECORD_BRIDGE_PORT="):
        raise RuntimeError("BRIDGE_FAILED_TO_START")
    port = int(header.split("=")[1])
    with output_path.open("x", encoding="utf8") as log:
        for original_index, task_id in task_plan:
            start = time.perf_counter()
            outcome = {"task_id": task_id, "plan_index": original_index, "seed": args.seed,
                       "reward": 0.0, "steps": 0, "agent": "meta-muse-spark-1.3-contributor",
                       "executor": "mecord-browser.cdp-isolated", "error": None}
            env = None
            try:
                env = gym.make(task_id, headless=True)
                obs, info = env.reset(seed=args.seed)
                time.sleep(0.08)
                history = []
                for step in range(args.max_steps):
                    if time.perf_counter() - start > 145:
                        raise RuntimeError("TASK_WALL_TIMEOUT")
                    # Mecord RC6, not BrowserGym AX, is the dispatch authority.
                    # Each turn receives fresh generation-bound refs and visual geometry.
                    mecord_inspection = bridge_call(port, {"op":"inspect"})
                    if not mecord_inspection.get("ok") or mecord_inspection.get("provider") != "browser.cdp":
                        raise RuntimeError("MECORD_OBSERVATION_FAILED")
                    candidates = observed_mecord_candidates(mecord_inspection,limit=90)
                    if not candidates:
                        raise RuntimeError("NO_MECORD_GROUNDED_TARGETS")
                    prompt = (
                        "You control an isolated synthetic MiniWoB page. Choose one next action "
                        "from Mecord's CURRENT verified actionable controls and visual objects. "
                        "Use the exact current bid (a generation-bound Mecord ref); never invent CSS, "
                        "coordinates, refs or authority. Return ONLY JSON with exactly four strings: "
                        '{"op":"click","bid":"b-current-observed-ref","value":"","key":""}. '
                        "Supported actions: click,set_value,type,select,key_press,hover,click_relative. "
                        "For candidates with description visual-geometry, use click_relative. "
                        "Its center is verified and hit-tested by Mecord, with no model-supplied coordinates. "
                        "For textbox values use set_value. Do not claim completion. "
                        f"Goal: {str(obs.get('goal') or '')[:800]}\\n"
                        "CURRENT Mecord controls/visual objects: " + json.dumps(candidates,ensure_ascii=True)[:12500]
                        + "\\nPrevious actions: " + json.dumps(history[-3:])[:800]
                        + "\\nSelect exactly one next action, with a bid from CURRENT controls."
                    )
                    model_action, status = request_model(prompt)
                    try:
                        grounded = verified_action(model_action,candidates,history) if status=="completed" else None
                    except MecordObservationError:
                        grounded = None
                    if grounded is None:
                        # One bounded model correction only; do not guess or dispatch invalid actions.
                        model_action, status = request_model(
                            prompt + "\nPrevious response was incomplete or an invalid operation. "
                            "Return one complete JSON object with exactly op,bid,value,key. "
                            "All fields must be strings and bid must be copied from current candidates.")
                    if status != "completed":
                        raise RuntimeError("MODEL_RESPONSE_INCOMPLETE")
                    if grounded is None:
                        grounded = verified_action(model_action,candidates,history)
                    if grounded.get("op")=="wait":
                        obs,reward,done,truncated,info=env.step("noop()")
                        outcome["reward"]=float(reward)
                        if done or truncated:break
                        continue
                    op=grounded["op"]
                    bid=grounded["ref"]
                    request = {"op":op,"ref":bid}
                    if op in {"set_value","type","select"}:
                        request["value"]=grounded["value"]
                    if op=="key_press":request["key"]=grounded["key"]
                    result = bridge_call(port, request)
                    if not result.get("ok") or result.get("provider") != "browser.cdp":
                        raise RuntimeError("MECORD_EXECUTION_" + str(result.get("error") or "UNKNOWN")[:70])
                    history.append({"op":op,"bid":bid,"value":request.get("value",""),
                                    "role":next(x["role"] for x in candidates if x["bid"]==bid),
                                    "provider_ms":result.get("durationMs")})
                    obs, reward, done, truncated, info = env.step("noop()")
                    outcome["steps"] += 1
                    outcome["reward"] = float(reward)
                    if done or truncated: break
            except Exception as exc:
                outcome["error"] = type(exc).__name__ + ":" + str(exc)[:100]
            finally:
                if env:
                    try:env.close()
                    except:pass
            outcome["elapsed_sec"] = round(time.perf_counter() - start, 2)
            outcome["cumulative_cost_usd"] = round(cost, 7)
            outcome["api_calls_cumulative"] = api_calls
            log.write(json.dumps(outcome, ensure_ascii=True) + "\n")
            log.flush()
            print("META_MECORD_EPISODE=" + json.dumps(outcome), flush=True)
    print("META_MECORD_SUMMARY=" + json.dumps({
        "attempted": len(task_plan), "api_calls": api_calls,
        "input_tokens": in_tokens, "output_tokens": out_tokens,
        "estimated_cost_usd": round(cost, 7), "cap_usd": args.cap_usd,
        "path": str(output_path), "worker": args.worker, "workers": args.workers,
        "note": "Synthetic MiniWoB, real Mecord browser.cdp, no production relay."}), flush=True)
finally:
    bridge.terminate()
    try:bridge.wait(timeout=4)
    except:bridge.kill()
    key = None
    BrowserType.launch = _ORIGINAL_LAUNCH
