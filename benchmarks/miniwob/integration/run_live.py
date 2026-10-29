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
arg.add_argument("--max-steps", type=int, default=6)
arg.add_argument("--cap-usd", type=float, default=0.005)
arg.add_argument("--seed", type=int, default=42)
arg.add_argument("--task-id", type=str, default=None)
arg.add_argument("--start-at",type=int,default=0)
arg.add_argument("--count",type=int,default=None)
arg.add_argument("--campaign-tag",type=str,default="v6")
arg.add_argument("--vision",action="store_true",help="Opt-in CDP screenshot input for Meta")
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
# Hash the GLOBAL campaign first, before sharding. Every worker then reports
# the same immutable roster digest; worker-specific partitions are recorded too.
full_campaign_plan = [(i, all_tasks[index]) for i, index in enumerate(indices)]
global_plan_sha256 = sha256(json.dumps(full_campaign_plan,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
task_plan = [row for row in full_campaign_plan if row[0] % args.workers == args.worker]
if args.task_id:
    if args.task_id not in all_tasks:
        raise RuntimeError("TASK_ID_NOT_IN_FROZEN_BROWSERGYM_ROSTER")
    task_plan = [(all_tasks.index(args.task_id), args.task_id)]
frozen_plan_sha256=sha256(json.dumps(task_plan,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
if type(args.start_at) is not int or not 0 <= args.start_at < len(task_plan):
    raise RuntimeError("INVALID_CAMPAIGN_OFFSET")
if args.count is not None and (type(args.count) is not int or not 1 <= args.count <= len(task_plan)-args.start_at):
    raise RuntimeError("INVALID_CAMPAIGN_COUNT")
if not re.fullmatch(r"[a-z0-9]{1,14}",args.campaign_tag):
    raise RuntimeError("INVALID_CAMPAIGN_TAG")
task_plan=task_plan[args.start_at:args.start_at+args.count if args.count is not None else None]
cost = 0.0
in_tokens = 0
out_tokens = 0
api_calls = 0
max_out_tokens = 2048
output_dir = B / "results"
output_dir.mkdir(parents=True, exist_ok=True)
case_label = (args.task_id.split(".")[-1] if args.task_id else f"{args.limit}")
output_path = output_dir / f"meta_rc6_grounded_{args.campaign_tag}_{case_label}_seed{args.seed}_worker{args.worker}of{args.workers}_offset{args.start_at}_count{len(task_plan)}.jsonl"
if output_path.exists():
    raise RuntimeError("RESULTS_ALREADY_EXIST_REFUSE_OVERWRITE")
# A shared, short-lived O_EXCL lock serializes budget reservations across all
# workers. Never hold this lock while a browser or Meta call is running.
# The append-only ledger is the authority; a timed-out owner must not be stolen.
budget_lock = output_dir / ".mecord-budget.lock"
ledger_path = output_dir / "mecord-api-reservations.jsonl"
lifetime_cap_usd = 0.07
historical_reservations = 0.0
run_reserved = 0.0

def _read_reserved():
    total = 0.0
    if ledger_path.exists():
        for line in ledger_path.read_text(encoding="utf8").splitlines():
            try: entry = json.loads(line)
            except (ValueError,TypeError): raise RuntimeError("MODEL_LEDGER_CORRUPT") from None
            amount = entry.get("usd") if type(entry) is dict else None
            if type(amount) not in (int,float) or not math.isfinite(amount) or amount <= 0:
                raise RuntimeError("MODEL_LEDGER_CORRUPT")
            total += amount
    return total

def reserve_budget(usd):
    global historical_reservations,run_reserved
    if not math.isfinite(usd) or usd<=0:
        raise RuntimeError("INVALID_API_RESERVATION")
    marker = f"{os.getpid()}-{secrets.token_hex(16)}"
    deadline = time.monotonic()+12
    while True:
        try:
            fd = os.open(budget_lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            try:
                os.write(fd,marker.encode("ascii"))
                os.fsync(fd)
            finally:os.close(fd)
            break
        except FileExistsError:
            if time.monotonic() > deadline:
                raise RuntimeError("BENCHMARK_BUDGET_LOCK_BUSY")
            time.sleep(0.04)
    try:
        current = _read_reserved()
        if run_reserved+usd > args.cap_usd or current+usd > lifetime_cap_usd:
            raise RuntimeError("BUDGET_CAP_REACHED")
        with ledger_path.open("a",encoding="utf8") as ledger:
            ledger.write(json.dumps({"usd":round(usd,9),"type":"api_reservation",
                "worker":args.worker,"workers":args.workers,
                "global_manifest":global_plan_sha256})+"\\n")
            ledger.flush()
            os.fsync(ledger.fileno())
        historical_reservations=current+usd
        run_reserved+=usd
    finally:
        # The owner that created this exact lock must be the one to remove it.
        try:
            if budget_lock.read_text(encoding="ascii") == marker:
                budget_lock.unlink()
        except OSError:
            pass

bridge_token = secrets.token_hex(32)
# Explicit minimal environment: never pass unrelated host credentials to CDP.
BRIDGE_ENV_ALLOWED = {"PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","WINDIR",
    "HOME","USERPROFILE","LOCALAPPDATA","APPDATA","TEMP","TMP",
    "MECORD_MINIWOB_WORKDIR","MECORD_MINIWOB_RUNTIME_PATH","MECORD_BENCH_CDP_PORT",
    "MECORD_MINIWOB_FRAME_ORIGINS"}
bridge_env = {k:v for k,v in os.environ.items() if k in BRIDGE_ENV_ALLOWED}
bridge_env["MECORD_MINIWOB_BRIDGE_TOKEN"] = bridge_token
bridge = subprocess.Popen(["node",str(Path(__file__).with_name("mecord_bridge.mjs"))],
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                          env=bridge_env,text=True,bufsize=1)
JSON_ACTION_SCHEMA = {
    "type":"json_schema",
    "json_schema":{"name":"mecord_browser_action","strict":True,"schema":{
        "type":"object","properties":{
            "op":{"type":"string","enum":["click","set_value","type","select","key_press","hover","click_relative","select_date","scroll","drag_between","wait","drag_by","resize","hotkey","keyboard_text","format_text","select_text_range"]},
            "bid":{"type":"string"},"value":{"type":"string"},"key":{"type":"string"}
        },
        "required":["op","bid","value","key"],"additionalProperties":False
    }}
}
def request_model(prompt, *, output_limit=None, screenshot=None):
    global cost,in_tokens,out_tokens,api_calls
    tokens = output_limit if output_limit is not None else max_out_tokens
    if type(tokens) is not int or not 256 <= tokens <= 3072:
        raise RuntimeError("MODEL_OUTPUT_CAP_INVALID")
    # Reserve against a conservative byte-level input bound plus protocol
    # overhead rather than assuming one token per ten UTF-8 bytes.
    if screenshot is not None:
        if (type(screenshot) is not str or not 0 < len(screenshot) <= 250000 or
                re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", screenshot) is None):
            raise RuntimeError("SCREENSHOT_INPUT_INVALID")
        # Conservative image-token reservation; authoritative usage is provider-reported.
        image_reserve_tokens = 32768
        content = [{"type":"text","text":prompt},
            {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+screenshot}}]
    else:
        image_reserve_tokens = 0
        content = prompt
    reserve = ((len(prompt.encode("utf8")) + 1024 + image_reserve_tokens)*0.10 + tokens*0.20)/1e6
    reserve_budget(reserve)
    payload={"model":"muse-spark-1.3-contributor",
             "messages":[{"role":"user","content":content}],
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

def compact_candidate_json(candidates, max_chars=12500):
    """Never truncate in the middle of a JSON element or target ref."""
    kept = []
    for candidate in candidates:
        presentation = {k:v for k,v in candidate.items() if k != "identity" and v is not None}
        proposed = kept + [presentation]
        if len(json.dumps(proposed,ensure_ascii=True)) > max_chars:
            break
        kept.append(presentation)
    return json.dumps(kept,ensure_ascii=True),len(candidates)-len(kept)


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
    try:
        with urllib.request.urlopen(req, timeout=21) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail=json.loads(exc.read(1024).decode("utf8","replace"))
        except (ValueError,UnicodeDecodeError):
            detail={}
        reason=detail.get("error") if isinstance(detail,dict) else None
        # Never turn an execution rejection into an accepted browser action.
        return {"ok":False,"provider":None,
                "error":("BRIDGE_HTTP_"+str(exc.code)+"_"+str(reason or "UNKNOWN"))[:110]}
    except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
        raise RuntimeError("LOCAL_BRIDGE_TRANSPORT_" + type(exc).__name__) from None

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
    scored_successes = 0
    scored_failures = 0
    unscored_episodes = 0
    with output_path.open("x", encoding="utf8") as log:
        for original_index, task_id in task_plan:
            attempted_count += 1
            start = time.perf_counter()
            outcome = {"task_id": task_id, "plan_index": original_index, "seed": args.seed,
                       "reward": 0.0, "steps": 0, "agent": "meta-muse-spark-1.3-contributor",
                       "executor": "mecord-browser.cdp-isolated", "error": None,
                        "trace":[], "step_limit":args.max_steps, "frozen_plan_sha256":frozen_plan_sha256,
                        "global_campaign_sha256":global_plan_sha256,"vision_enabled":args.vision,
                         "worker":args.worker,"workers":args.workers}
            env = None
            try:
                env = gym.make(task_id, headless=True)
                obs, info = env.reset(seed=args.seed)
                time.sleep(0.08)
                history = []
                for step in range(args.max_steps):
                    event = {"step":step+1}
                    outcome["trace"].append(event)
                    if time.perf_counter() - start > 145:
                        raise RuntimeError("TASK_WALL_TIMEOUT")
                    # Mecord RC6, not BrowserGym AX, is the dispatch authority.
                    # Each turn receives fresh generation-bound refs and visual geometry.
                    mecord_inspection = bridge_call(port, {"op":"inspect","visual":args.vision})
                    if not mecord_inspection.get("ok") or mecord_inspection.get("provider") != "browser.cdp":
                        raise RuntimeError("MECORD_OBSERVATION_FAILED")
                    candidates = observed_mecord_candidates(mecord_inspection,limit=90)
                    if not candidates:
                        raise RuntimeError("NO_MECORD_GROUNDED_TARGETS")
                    candidate_json,hidden_count = compact_candidate_json(candidates)
                    event.update({"observed_candidates":len(candidates),
                        "hidden_candidates":hidden_count,
                        "observation_generation":mecord_inspection["page"]["semantic"]["observationGeneration"],
                        "observation_pagination":mecord_inspection.get("pagination"),
                         "accepted_frames":mecord_inspection.get("acceptedFrames"),
                         "rejected_frames":mecord_inspection.get("rejectedFrames"),
                         "frame_coverage":mecord_inspection.get("frameCoverage"),
                         "screenshot_status":mecord_inspection.get("screenshotStatus"),
                         "screenshot_sha256":mecord_inspection.get("screenshotSha256")})
                    prompt = (
                        "You control an isolated synthetic MiniWoB page. Choose one next action "
                        "from Mecord's CURRENT verified actionable controls and visual objects. "
                        "Use the exact current bid (a generation-bound Mecord ref); never invent CSS, "
                        "coordinates, refs or authority. Return ONLY JSON with exactly four strings: "
                        '{"op":"click","bid":"b-current-observed-ref","value":"","key":""}. '
                        "Supported actions: click,set_value,type,select,key_press,hover,click_relative,select_date,scroll,drag_between,wait,drag_by,resize,hotkey,keyboard_text,format_text,select_text_range. "
                        "For wait use empty bid/value/key. For hotkey put CTRL+A/CTRL+B/CTRL+I/CTRL+U/CTRL+Z in key. "
                        "For drag_by or resize, value is direction:40/80/160. For format_text use bold/italic/underline. "
                        "For select_text_range use start:end as value. For keyboard_text use an editable target. "
                        "For scrollable candidates use scroll with value up/down or up:160/down:320. "
                        "For sortable-geometry candidates use drag_between with bid as observed source ref "
                        "and value as observed destination ref (same generation). "
                        "Do not invent either ref. "
                        "For visual-geometry, use click_relative with value center,left,right,top,bottom,top-left,top-right,bottom-left,bottom-right. "
                        "Every enumerated point is inside the observed target and independently hit-tested by Mecord. "
                        "For date inputs with inputType date use select_date and ISO YYYY-MM-DD. "
                        "For textbox values use set_value. Do not claim completion. "
                        f"Goal: {str(obs.get('goal') or '')[:1300]}\n"
                        "CURRENT Mecord controls/visual objects: " + candidate_json
                        + "\nPage headings: " + json.dumps(mecord_inspection.get("headings") or [],ensure_ascii=True)[:1000]
                        + "\nVisible page excerpt: " + str(mecord_inspection.get("textExcerpt") or "")[:1200]
                        + "\nMore omitted candidates: " + str(hidden_count)
                        + "\nPrevious actions: " + json.dumps(history[-4:],ensure_ascii=True)[:2200]
                        + "\nSelect exactly one next action, with a bid from CURRENT controls."
                    )
                    event["candidate_digest"] = sha256(candidate_json.encode("utf8")).hexdigest()[:20]
                    event["api_calls_before"] = api_calls
                    event["input_tokens_before"] = in_tokens
                    event["output_tokens_before"] = out_tokens
                    screenshot=mecord_inspection.get("screenshot") if args.vision else None
                    if args.vision and screenshot is None:
                        raise RuntimeError("MECORD_VISION_UNAVAILABLE")
                    model_action, status = request_model(prompt,screenshot=screenshot)
                    event["model_status"] = status
                    try:
                        grounded = verified_action(model_action,candidates,history) if status=="completed" else None
                    except MecordObservationError as invalid:
                        event["first_action_error"] = str(invalid)[:80]
                        grounded = None
                    if grounded is None:
                        # One bounded model correction only; do not guess or dispatch invalid actions.
                        model_action, status = request_model(
                            prompt + "\nPrevious response was incomplete or an invalid operation. "
                            "Return one complete JSON object with exactly op,bid,value,key. "
                            "All fields must be strings and bid must be copied from current candidates.",
                            output_limit=3072 if status=="truncated" else max_out_tokens,
                             screenshot=screenshot
                        event["corrective_model_status"] = status
                    event["api_calls_after"] = api_calls
                    event["input_tokens_used"] = in_tokens - event["input_tokens_before"]
                    event["output_tokens_used"] = out_tokens - event["output_tokens_before"]
                    if status != "completed":
                        raise RuntimeError("MODEL_RESPONSE_" + status.upper())
                    if grounded is None:
                        grounded = verified_action(model_action,candidates,history)
                    event["decision"] = {"op":grounded["op"],
                        "target":grounded.get("ref",""),
                        "value_hash":sha256(grounded.get("value","").encode()).hexdigest()[:16]}
                    if grounded.get("op")=="wait":
                        event["wait"] = True
                        obs,reward,done,truncated,info=env.step("noop()")
                        outcome["reward"]=float(reward)
                        if done or truncated:break
                        continue
                    op=grounded["op"]
                    bid=grounded["ref"]
                    request = {"op":op,"ref":bid}
                    if op in {"set_value","type","select","select_date","scroll","drag_between","drag_by","resize","keyboard_text","format_text","select_text_range"}:
                        request["value"]=grounded["value"]
                    if op in {"key_press","hotkey"}:request["key"]=grounded["key"]
                    result = bridge_call(port, request)
                    event.update({"provider_ok":result.get("ok") is True,
                        "provider_error":result.get("error"),
                        "provider_ms":result.get("durationMs"),
                        "state_progress":result.get("stateProgress"),
                        "side_effect_state":result.get("sideEffectState"),
                        "execution_phase":result.get("executionPhase")})
                    if not result.get("ok") or result.get("provider") != "browser.cdp":
                        # Only a proven pre-dispatch/no-effect refusal may be
                        # followed by a fresh observation and a NEW decision.
                        if result.get("executionPhase")=="pre_dispatch" and result.get("sideEffectState")=="none":
                            event["recovery"] = "REOBSERVE_WITHOUT_REPLAY"
                            continue
                        raise RuntimeError("MECORD_EXECUTION_" + str(result.get("error") or "UNKNOWN")[:70])
                    selected = next(x for x in candidates if x["bid"]==bid)
                    history.append({"op":op,"bid":bid,"value":request.get("value",""),
                                    "identity":selected.get("identity"),
                                    "name":selected.get("name","")[:80],
                                    "role":selected["role"],
                                    "progress":result.get("stateProgress"),
                                    "provider_ms":result.get("durationMs")})
                    obs, reward, done, truncated, info = env.step("noop()")
                    outcome["steps"] += 1
                    outcome["reward"] = float(reward)
                    event["reward"] = float(reward)
                    event["episode_done"] = bool(done or truncated)
                    if done or truncated: break
            except Exception as exc:
                outcome["error"] = type(exc).__name__ + ":" + str(exc)[:100]
                if outcome["trace"]:
                    outcome["trace"][-1]["failure"] = outcome["error"]
                if isinstance(exc,(urllib.error.URLError,TimeoutError,ConnectionError)):
                    campaign_stop = "META_TRANSPORT_UNCERTAIN"
                    outcome["reward"] = None
                    outcome["unscored"] = True
                if str(exc).startswith("LOCAL_BRIDGE_TRANSPORT_"):
                    campaign_stop = "LOCAL_BRIDGE_TRANSPORT_UNCERTAIN"
                    outcome["reward"] = None
                    outcome["unscored"] = True
                if str(exc) in {"BUDGET_CAP_REACHED","MODEL_USAGE_MISSING"} or str(exc).startswith(("META_HTTP_429","META_HTTP_503","META_HTTP_504")):
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
            if outcome.get("unscored") is True or outcome["reward"] is None:
                unscored_episodes += 1
            elif outcome["reward"] == 1.0:
                scored_successes += 1
            else:
                scored_failures += 1
            log.write(json.dumps(outcome, ensure_ascii=True) + "\n")
            log.flush()
            print("META_MECORD_EPISODE=" + json.dumps(outcome), flush=True)
            if campaign_stop:
                break
    print("META_MECORD_SUMMARY=" + json.dumps({
        "attempted":attempted_count,"scheduled":len(task_plan),
        "frozen_plan_sha256":frozen_plan_sha256,
        "global_campaign_sha256":global_plan_sha256,
        "start_at":args.start_at,"count":len(task_plan),"campaign_tag":args.campaign_tag,
        "scored":scored_successes+scored_failures,
        "successes":scored_successes,"failures":scored_failures,
        "unscored":unscored_episodes,
        "success_rate_scored":(scored_successes/(scored_successes+scored_failures)
            if scored_successes+scored_failures else None),
        "status":"COMPLETE" if not campaign_stop and attempted_count==len(task_plan) else "PARTIAL",
        "full_50_task_70_percent_gate":("PASS" if scored_successes>=35 else "FAIL")
            if args.limit==50 and args.workers==1 and args.count is None and args.start_at==0
            and attempted_count==50 and not campaign_stop else "NOT_RUN",
        "campaign_stop":campaign_stop,
        "api_calls":api_calls,
        "input_tokens": in_tokens, "output_tokens": out_tokens,
        "estimated_cost_usd":round(cost,7), "reserved_usd":round(run_reserved,7),
        "workspace_reserved_usd":round(historical_reservations,7),
        "lifetime_cap_usd":lifetime_cap_usd,"cap_usd":args.cap_usd,
        "path": str(output_path), "worker": args.worker, "workers": args.workers,
        "vision_enabled":args.vision,
        "note": "Synthetic MiniWoB, real Mecord browser.cdp, no production relay."}), flush=True)
finally:
    bridge.terminate()
    try:bridge.wait(timeout=4)
    except:bridge.kill()
    key = None
    BrowserType.launch = _ORIGINAL_LAUNCH
    pass  # Short-lived reservations release their own shared lock
