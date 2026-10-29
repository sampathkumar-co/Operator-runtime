"""Reproducible synthetic MiniWoB: Meta Muse -> Mecord browser.cdp -> BrowserGym reward.
No public relay, no personal browsing, no secret output. Task selection is systematic.
"""
import os, json, re, time, argparse, subprocess, urllib.request, urllib.error, sys, secrets, queue, threading, math, atexit
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
arg.add_argument("--cap-usd", type=float, default=0.005)
arg.add_argument("--seed", type=int, default=42)
arg.add_argument("--task-id", type=str, default=None)
args = arg.parse_args()
assert 1 <= args.limit <= 125 and 1 <= args.workers <= 4
assert 0 <= args.worker < args.workers and 1 <= args.max_steps <= 10
if not math.isfinite(args.cap_usd) or not 0.001 <= args.cap_usd <= 0.07:
    raise RuntimeError("BENCHMARK_CAP_INVALID")
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
# Lock per benchmark workspace and reserve the maximum estimated API charge
# DURABLY before any outbound request. Charges are never refunded for transport
# errors because a provider could have processed the request before timing out.
budget_lock = output_dir / ".mecord-budget.lock"
try:
    lock_fd = os.open(budget_lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.write(lock_fd,str(os.getpid()).encode())
    os.close(lock_fd)
except FileExistsError:
    raise RuntimeError("BENCHMARK_BUDGET_LOCK_EXISTS")
def _unlock_owned_workspace():
    # Never clear a lock recreated by another process.
    try:
        if budget_lock.read_text(encoding="ascii") == str(os.getpid()):
            budget_lock.unlink()
    except OSError:
        pass
atexit.register(_unlock_owned_workspace)
ledger_path = output_dir / "mecord-api-reservations.jsonl"
lifetime_cap_usd = 0.07  # < INR 7 at ~95.3/USD; leaves buffer for prior use + FX
historical_reservations = 0.0
if ledger_path.exists():
    for line in ledger_path.read_text(encoding="utf8").splitlines():
        entry=json.loads(line)
        amount=entry.get("usd")
        if type(amount) not in (int,float) or not math.isfinite(amount) or amount<=0:
            raise RuntimeError("MODEL_LEDGER_CORRUPT")
        historical_reservations+=amount
run_reserved = 0.0
def reserve_budget(usd):
    global historical_reservations,run_reserved
    if not math.isfinite(usd) or usd<=0:
        raise RuntimeError("INVALID_API_RESERVATION")
    if run_reserved+usd > args.cap_usd or historical_reservations+usd > lifetime_cap_usd:
        raise RuntimeError("BUDGET_CAP_REACHED")
    with ledger_path.open("a",encoding="utf8") as ledger:
        ledger.write(json.dumps({"usd":round(usd,9),"type":"api_reservation"})+"\n")
        ledger.flush()
        os.fsync(ledger.fileno())
    historical_reservations+=usd
    run_reserved+=usd

bridge_token = secrets.token_hex(32)
bridge_env = dict(os.environ)
# The browser tool process has no need for model credentials.
bridge_env.pop("MUSE_API_KEY",None)
bridge_env["MECORD_MINIWOB_BRIDGE_TOKEN"] = bridge_token
bridge = subprocess.Popen(["node",str(Path(__file__).with_name("mecord_bridge.mjs"))],
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                          env=bridge_env,text=True,bufsize=1)
JSON_ACTION_SCHEMA = {
    "type":"json_schema",
    "json_schema":{"name":"mecord_browser_action","strict":True,"schema":{
        "type":"object","properties":{
            "op":{"type":"string","enum":["click","set_value","type","select","key_press","hover","click_relative","select_date"]},
            "bid":{"type":"string"},"value":{"type":"string"},"key":{"type":"string"}
        },
        "required":["op","bid","value","key"],"additionalProperties":False
    }}
}
def request_model(prompt, *, output_limit=None):
    global cost,in_tokens,out_tokens,api_calls
    tokens = output_limit if output_limit is not None else max_out_tokens
    if type(tokens) is not int or not 256 <= tokens <= 3072:
        raise RuntimeError("MODEL_OUTPUT_CAP_INVALID")
    reserve = (len(prompt.encode("utf8"))*0.10+tokens*0.20)/1e6
    reserve_budget(reserve)
    payload={"model":"muse-spark-1.3-contributor",
             "messages":[{"role":"user","content":prompt}],
             "response_format":JSON_ACTION_SCHEMA,
             "reasoning_effort":"low",
             "max_tokens":tokens}
    req=urllib.request.Request("https://api.meta.ai/v1/chat/completions",
                               data=json.dumps(payload).encode(),method="POST",
                               headers={"Authorization":"Bearer "+key,"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=55) as response:data=json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError("META_HTTP_"+str(exc.code)) from None
    u=data.get("usage") or {}
    ti=int(u.get("prompt_tokens") or 0);to=int(u.get("completion_tokens") or 0)
    in_tokens+=ti;out_tokens+=to;api_calls+=1
    if ti<=0 or to<0:
        raise RuntimeError("MODEL_USAGE_MISSING")
    cost+=(ti*.10+to*.20)/1e6
    choices=data.get("choices") or []
    if not choices:return {}, "incomplete"
    choice=choices[0]
    content=(choice.get("message") or {}).get("content") or ""
    if not isinstance(content,str):
        return {}, "truncated" if choice.get("finish_reason")=="length" else "incomplete"
    status = "completed" if choice.get("finish_reason")=="stop" else (
        "truncated" if choice.get("finish_reason")=="length" else "incomplete")
    try:action=json.loads(content)
    except json.JSONDecodeError:return {},status if status=="truncated" else "incomplete"
    return action if isinstance(action,dict) else {},status

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
                                 method="POST", headers={"Content-Type": "application/json",
                                   "Authorization":"Bearer "+bridge_token})
    with urllib.request.urlopen(req, timeout=21) as response:
        return json.load(response)

try:
    headers = queue.Queue(maxsize=1)
    threading.Thread(target=lambda:headers.put(bridge.stdout.readline()),daemon=True).start()
    try:header = headers.get(timeout=12).strip()
    except queue.Empty:raise RuntimeError("BRIDGE_STARTUP_TIMEOUT") from None
    if not header.startswith("MECORD_BRIDGE_PORT="):
        raise RuntimeError("BRIDGE_FAILED_TO_START")
    port = int(header.split("=")[1])
    attempted_count = 0
    campaign_stop = None
    with output_path.open("x", encoding="utf8") as log:
        for original_index, task_id in task_plan:
            attempted_count += 1
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
                        "For date inputs with inputType date use select_date and ISO YYYY-MM-DD. "
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
                            "All fields must be strings and bid must be copied from current candidates.",
                            output_limit=3072 if status=="truncated" else max_out_tokens)
                    if status != "completed":
                        raise RuntimeError("MODEL_RESPONSE_" + status.upper())
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
                    if op in {"set_value","type","select","select_date"}:
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
                if str(exc) in {"BUDGET_CAP_REACHED","MODEL_USAGE_MISSING"} or str(exc).startswith("META_HTTP_429"):
                    campaign_stop = "API_BUDGET_OR_PROVIDER_STOP"
                    # No independently scored task result is inferred when
                    # the call never ran or token accounting is inconclusive.
                    outcome["reward"] = None
                    outcome["unscored"] = True
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
            if campaign_stop:
                break
    print("META_MECORD_SUMMARY=" + json.dumps({
        "attempted":attempted_count,"scheduled":len(task_plan),
        "scored":attempted_count - (1 if campaign_stop else 0),
        "status":"COMPLETE" if attempted_count==len(task_plan) else "PARTIAL",
        "campaign_stop":campaign_stop,
        "api_calls":api_calls,
        "input_tokens": in_tokens, "output_tokens": out_tokens,
        "estimated_cost_usd":round(cost,7), "reserved_usd":round(run_reserved,7),
        "workspace_reserved_usd":round(historical_reservations,7),
        "lifetime_cap_usd":lifetime_cap_usd,"cap_usd":args.cap_usd,
        "path": str(output_path), "worker": args.worker, "workers": args.workers,
        "note": "Synthetic MiniWoB, real Mecord browser.cdp, no production relay."}), flush=True)
finally:
    bridge.terminate()
    try:bridge.wait(timeout=4)
    except:bridge.kill()
    key = None
    BrowserType.launch = _ORIGINAL_LAUNCH
    _unlock_owned_workspace()
