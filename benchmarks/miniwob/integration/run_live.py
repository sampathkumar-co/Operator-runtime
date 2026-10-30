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
if not (1 <= args.limit <= 125 and 1 <= args.workers <= 4 and
        0 <= args.worker < args.workers and 1 <= args.max_steps <= 10):
    raise RuntimeError("BENCHMARK_ARGUMENTS_INVALID")
if not math.isfinite(args.cap_usd) or not 0.001 <= args.cap_usd <= 0.07:
    raise RuntimeError("BENCHMARK_CAP_INVALID")
cdp_port = 9330 + args.worker
os.environ["MECORD_BENCH_CDP_PORT"] = str(cdp_port)
os.environ["MINIWOB_URL"] = (B / "miniwob-plusplus" / "miniwob" / "html" / "miniwob").as_uri() + "/"
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(Path.home() / "AppData" / "Local" / "ms-playwright")
import gymnasium as gym
import browsergym.miniwob
from mecord_observation import observed_mecord_candidates,verified_action,MecordObservationError
from integration.budget_ledger import BudgetLedger, require_budget_feasibility
from integration.inspection_paging import next_page_offsets
from integration.outcome_scoring import score_terminal_if_unstepped
from integration.bridge_protocol import parse_bridge_http_rejection
from integration.model_failures import safe_meta_http_error,classify_episode_failure
from integration.api_accounting import checked_reported_usage
from integration.campaign_plan import plan_tasks
from integration.checkpoint_integrity import seal_row,ZERO_DIGEST
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
if len(all_tasks) != 125 or len(set(all_tasks)) != 125:
    raise RuntimeError("CANONICAL_125_TASK_ROSTER_REQUIRED")
# Debugging is deliberately non-qualifying and uses index zero.
if args.task_id and (args.start_at!=0 or args.count is not None):
    raise RuntimeError("SINGLE_TASK_DEBUG_MUST_BE_UNSHARDED")
try:
    full_campaign_plan,task_plan,task_debug=plan_tasks(
        all_tasks,args.limit,args.workers,args.worker,args.task_id)
except ValueError as exc:
    raise RuntimeError(str(exc)) from None
global_plan_sha256 = sha256(json.dumps(full_campaign_plan,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
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
# Fingerprint the entire adapter/controller/bridge contract. Every resumed
# checkpoint must use the same implementation, not merely the same task list.
harness_files = [
    ROOT / "controller.py",
    ROOT / "mecord_observation.py",
    Path(__file__).resolve(),
    Path(__file__).with_name("mecord_bridge.mjs"),
    Path(__file__).with_name("bridge_actions.mjs"),
    Path(__file__).with_name("bridge_protocol.py"),
    Path(__file__).with_name("budget_ledger.py"),
    Path(__file__).with_name("browser_visual.mjs"),
    Path(__file__).with_name("model_failures.py"),
    Path(__file__).with_name("runtime_pin.mjs"),
    Path(__file__).with_name("inspection_paging.py"),
    Path(__file__).with_name("outcome_scoring.py"),
    Path(__file__).with_name("api_accounting.py"),
    Path(__file__).with_name("campaign_plan.py"),
    Path(__file__).with_name("checkpoint_integrity.py"),
]
if not all(p.is_file() for p in harness_files):
    raise RuntimeError("BENCHMARK_HARNESS_FILE_MISSING")
runtime_manifest_path=Path(os.environ["MECORD_MINIWOB_RUNTIME_PATH"]).resolve() / "runtime" / "runtime-manifest.json"
runtime_manifest_bytes=runtime_manifest_path.read_bytes()
runtime_manifest_sha256=sha256(runtime_manifest_bytes).hexdigest()
runtime_manifest_info=json.loads(runtime_manifest_bytes)
if type(runtime_manifest_info) is not dict:
    raise RuntimeError("RUNTIME_MANIFEST_INVALID")

harness_sha256 = sha256(json.dumps(
    [(p.name,sha256(p.read_bytes()).hexdigest()) for p in harness_files],
    separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
output_dir = B / "results"
output_dir.mkdir(parents=True, exist_ok=True)
case_label = (args.task_id.split(".")[-1] if args.task_id else f"{args.limit}")
output_path = output_dir / f"meta_rc6_grounded_{args.campaign_tag}_{case_label}_seed{args.seed}_worker{args.worker}of{args.workers}_offset{args.start_at}_count{len(task_plan)}.jsonl"
if output_path.exists():
    raise RuntimeError("RESULTS_ALREADY_EXIST_REFUSE_OVERWRITE")
# All workers reserve against one durable ledger. A process keeps no
# exclusive workspace lock while waiting for Meta/CDP/browser actions.
lifetime_cap_usd = 0.07
ledger = BudgetLedger(output_dir,lifetime_cap=lifetime_cap_usd,
    run_cap=args.cap_usd,worker=args.worker,workers=args.workers,
    manifest=global_plan_sha256)
# Fail before any model call or bridge launch when even ONE reserved
# vision request per scheduled task exceeds the host-approved limits.
# Reservation is deliberately conservative; never silently raise the cap.
require_budget_feasibility(task_count=len(task_plan), vision=args.vision,
    run_cap=args.cap_usd, lifetime_cap=lifetime_cap_usd,
    already_reserved=ledger._sum(), output_tokens=max_out_tokens)
historical_reservations = 0.0
run_reserved = 0.0
def reserve_budget(usd):
    global historical_reservations,run_reserved
    historical_reservations,run_reserved=ledger.reserve(usd)

bridge_token = secrets.token_hex(32)
# Explicit minimal environment: never pass unrelated host credentials to CDP.
BRIDGE_ENV_ALLOWED = {"PATH","Path","PATHEXT","SystemRoot","SYSTEMROOT","WINDIR",
    "HOME","USERPROFILE","LOCALAPPDATA","APPDATA","TEMP","TMP",
    "MECORD_MINIWOB_WORKDIR","MECORD_MINIWOB_RUNTIME_PATH","MECORD_BENCH_CDP_PORT",
    "MECORD_MINIWOB_FRAME_ORIGINS",
    "MECORD_MINIWOB_NATIVE_GESTURES","MECORD_MINIWOB_EXPECTED_RUNTIME_VERSION",
    "MECORD_MINIWOB_EXPECTED_RUNTIME_COMMIT","MECORD_MINIWOB_EXPECTED_MANIFEST_SHA256"}
bridge_env = {k:v for k,v in os.environ.items() if k in BRIDGE_ENV_ALLOWED}
bridge_env["MECORD_MINIWOB_BRIDGE_TOKEN"] = bridge_token
bridge = subprocess.Popen(["node",str(Path(__file__).with_name("mecord_bridge.mjs"))],
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                          env=bridge_env,text=True,bufsize=1)
JSON_ACTION_SCHEMA = {
    "type":"json_schema",
    "json_schema":{"name":"mecord_browser_action","strict":True,"schema":{
        "type":"object","properties":{
            "op":{"type":"string","enum":["click","set_value","type","select","key_press","hover","click_relative","select_date","scroll","drag_between","drag_to","wait","drag_by","resize","hotkey","keyboard_text","format_text","select_text_range","dialog_accept","dialog_dismiss","double_click","shift_click","drag_path","inspect_next_page"]},
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
        raise RuntimeError(safe_meta_http_error(exc.code,exc.read(4096))) from None
    # The API request may already be charged even if its response is invalid.
    # Do not issue another call unless exact integer usage is available and
    # its estimated charge fits within the preceding reservation.
    api_calls+=1
    checked=checked_reported_usage(data.get("usage"),reservation_usd=reserve)
    ti=checked["prompt_tokens"];to=checked["completion_tokens"]
    in_tokens+=ti;out_tokens+=to
    cost+=checked["estimated_usage_usd"]
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
        # Only an exact bridge no-effect receipt can authorize re-observation.
        return parse_bridge_http_rejection(exc.code,detail)
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
        previous_record_sha256=ZERO_DIGEST
        for original_index, task_id in task_plan:
            attempted_count += 1
            start = time.perf_counter()
            outcome = {"task_id": task_id, "plan_index": original_index, "seed": args.seed,
                       "reward": 0.0, "steps": 0, "agent": "meta-muse-spark-1.3-contributor",
                       "executor": "mecord-browser.cdp-isolated", "error": None,
                        "trace":[], "step_limit":args.max_steps, "frozen_plan_sha256":frozen_plan_sha256,
                        "global_campaign_sha256":global_plan_sha256,"harness_sha256":harness_sha256,
                        "source_commit":source_commit,"vision_enabled":args.vision,
                         "runtime_manifest_sha256":runtime_manifest_sha256,
                         "runtime_version":runtime_manifest_info.get("version"),
                         "runtime_source_commit":runtime_manifest_info.get("sourceCommit"),
                         "native_gestures_enabled":None,
                         "worker":args.worker,"workers":args.workers,
                         "task_debug":task_debug,"failure_kind":None,
                         "cumulative_model_usage_estimate_usd":0.0}
            env = None
            try:
                env = gym.make(task_id, headless=True)
                obs, info = env.reset(seed=args.seed)
                time.sleep(0.08)
                history = []
                inspect_offsets={"controlOffset":0,"visualOffset":0}
                for step in range(args.max_steps):
                    event = {"step":step+1}
                    outcome["trace"].append(event)
                    if time.perf_counter() - start > 145:
                        raise RuntimeError("TASK_WALL_TIMEOUT")
                    # Mecord RC6, not BrowserGym AX, is the dispatch authority.
                    # Each turn receives fresh generation-bound refs and visual geometry.
                    mecord_inspection = bridge_call(port, {"op":"inspect","visual":args.vision,**inspect_offsets})
                    if not mecord_inspection.get("ok") or mecord_inspection.get("provider") != "browser.cdp":
                        raise RuntimeError("MECORD_OBSERVATION_FAILED")
                    candidates = observed_mecord_candidates(mecord_inspection,limit=90)
                    native_ready = mecord_inspection.get("nativeGesturesEnabled") is True
                    if outcome["native_gestures_enabled"] is not None and outcome["native_gestures_enabled"] != native_ready:
                        raise RuntimeError("NATIVE_RUNTIME_CAPABILITY_CHANGED")
                    outcome["native_gestures_enabled"]=native_ready
                    next_offsets=next_page_offsets(
                        mecord_inspection.get("pagination"),
                        current_control=inspect_offsets["controlOffset"],
                        current_visual=inspect_offsets["visualOffset"])
                    if not candidates:
                        if next_offsets:
                            inspect_offsets=next_offsets
                            event["recovery"]="NEXT_OBSERVED_PAGE_WITH_NO_TARGETS"
                            continue
                        raise RuntimeError("NO_MECORD_GROUNDED_TARGETS")
                    candidate_json,hidden_count = compact_candidate_json(candidates)
                    event.update({"observed_candidates":len(candidates),
                        "hidden_candidates":hidden_count,
                        "observation_generation":mecord_inspection["page"]["semantic"]["observationGeneration"],
                        "observation_pagination":mecord_inspection.get("pagination"),
                         "accepted_frames":mecord_inspection.get("acceptedFrames"),
                         "rejected_frames":mecord_inspection.get("rejectedFrames"),
                         "frame_coverage":mecord_inspection.get("frameCoverage"),
                         "native_gestures_enabled":native_ready,
                         "inspected_offsets":inspect_offsets.copy(),
                         "next_page_available":next_offsets is not None,
                         "screenshot_status":mecord_inspection.get("screenshotStatus"),
                         "screenshot_sha256":mecord_inspection.get("screenshotSha256")})
                    prompt = (
                        "You control an isolated synthetic MiniWoB page. Choose one next action "
                        "from Mecord's CURRENT verified actionable controls and visual objects. "
                        "Use the exact current bid (a generation-bound Mecord ref); never invent CSS, "
                        "coordinates, refs or authority. Return ONLY JSON with exactly four strings: "
                        '{"op":"click","bid":"b-current-observed-ref","value":"","key":""}. '
                        "Supported actions: click,set_value,type,select,key_press,hover,click_relative,select_date,scroll,drag_between,drag_to,wait,drag_by,resize,hotkey,keyboard_text,format_text,select_text_range,dialog_accept,dialog_dismiss. "
                        + ("Additional PINNED native operations: double_click,shift_click on exact actionable refs; drag_path on observed graphic ref using value=0.10:0.10;0.90:0.90 (2-24 relative points). " if native_ready else "Native gestures are unavailable in this runtime; do NOT request double_click,shift_click,drag_path. ") +
                        ("Use inspect_next_page with empty bid,value,key to inspect the next provider-validated control/visual page WITHOUT a browser action. " if next_offsets else "No further observed inspection page is available. ") +
                        "For a javascript-dialog candidate use dialog_accept or dialog_dismiss with its exact bid; value only for prompt accept. For wait use empty bid/value/key. For hotkey put CTRL+A/CTRL+B/CTRL+I/CTRL+U/CTRL+Z in key. "
                        "For drag_by or resize, value is one of eight compass directions (e.g. down-right:80), with distance 10/20/40/80/160/320. For format_text use bold/italic/underline. "
                        "For select_text_range use start:end as value. For keyboard_text use an editable target. "
                        "For scrollable candidates use scroll with up/down/left/right and optional :40/:80/:160/:320/:640. "
                        "For sortable-geometry candidates use drag_between with bid as observed source ref "
                        "and value as observed destination ref (same generation). "
                        "For drag_to, use any two observed graphical or actionable refs from the same frame and generation. Never invent refs. "
                        "For visual-geometry use click_relative with named points or a bounded two-axis 0.00..1.00 ratio like 0.35:0.72, or hover to move the pointer to its center. "
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
                    if args.vision and screenshot is None and not mecord_inspection.get("dialog"):
                        raise RuntimeError("MECORD_VISION_UNAVAILABLE")
                    model_action, status = request_model(prompt,screenshot=screenshot)
                    event["model_status"] = status
                    try:
                        grounded = verified_action(model_action,candidates,history,allow_native_gestures=native_ready) if status=="completed" else None
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
                             screenshot=screenshot)
                        event["corrective_model_status"] = status
                    event["api_calls_after"] = api_calls
                    event["input_tokens_used"] = in_tokens - event["input_tokens_before"]
                    event["output_tokens_used"] = out_tokens - event["output_tokens_before"]
                    if status != "completed":
                        raise RuntimeError("MODEL_RESPONSE_" + status.upper())
                    if grounded is None:
                        grounded = verified_action(model_action,candidates,history,allow_native_gestures=native_ready)
                    event["decision"] = {"op":grounded["op"],
                        "target":grounded.get("ref",""),
                        "value_hash":sha256(grounded.get("value","").encode()).hexdigest()[:16]}
                    if grounded.get("op")=="inspect_next_page":
                        if not next_offsets:
                            raise RuntimeError("PAGINATION_NOT_AVAILABLE")
                        inspect_offsets=next_offsets
                        event["next_page_offsets"]=next_offsets
                        continue
                    if grounded.get("op")=="wait":
                        event["wait"] = True
                        obs,reward,done,truncated,info=env.step("noop()")
                        outcome["steps"] += 1
                        outcome["reward"]=float(reward)
                        event["reward"]=float(reward)
                        event["episode_done"]=bool(done or truncated)
                        if done or truncated:break
                        continue
                    op=grounded["op"]
                    bid=grounded["ref"]
                    request = {"op":op,"ref":bid}
                    if op in {"set_value","type","select","select_date","scroll","drag_between","drag_to","drag_by","resize","keyboard_text","format_text","select_text_range","dialog_accept","click_relative","drag_path"}:
                        request["value"]=grounded["value"]
                    if op in {"key_press","hotkey"}:request["key"]=grounded["key"]
                    result = bridge_call(port, request)
                    inspect_offsets={"controlOffset":0,"visualOffset":0}
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
                            history.append({"op":op,"bid":bid,"value":request.get("value",""),
                                "role":next((x["role"] for x in candidates if x["bid"]==bid),""),
                                "error":str(result.get("error") or "VALIDATION_DENIED")[:80],
                                "sideEffectState":"none","progress":False})
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
                kind,unscored,stop=classify_episode_failure(exc)
                outcome["failure_kind"]=kind
                if outcome["trace"]:
                    outcome["trace"][-1]["failure"] = outcome["error"]
                if unscored:
                    campaign_stop=stop
                    outcome["reward"]=None
                    outcome["unscored"]=True
            finally:
                if env:
                    if outcome.get("unscored") is not True and outcome.get("steps")==0:
                        try:
                            score_terminal_if_unstepped(outcome,env)
                        except Exception:
                            outcome["reward"]=None
                            outcome["unscored"]=True
                            campaign_stop="BROWSERGYM_TERMINAL_REWARD_UNAVAILABLE"
                            outcome["trace"].append({"terminal_scorer_error":"BROWSERGYM_TERMINAL_REWARD_UNAVAILABLE"})
                    try:env.close()
                    except:pass
            outcome["cumulative_model_usage_estimate_usd"]=round(cost,7)
            outcome["elapsed_sec"] = round(time.perf_counter() - start, 2)
            outcome["cumulative_cost_usd"] = round(cost, 7)
            outcome["api_calls_cumulative"] = api_calls
            # A task diagnostic or an error without an independent failure
            # reward can never be silently counted as a valid success.
            if outcome.get("error") and outcome.get("reward")==1:
                outcome["reward"]=None
                outcome["unscored"]=True
                campaign_stop=campaign_stop or "ERROR_WITH_UNEXPECTED_SUCCESS"
            if outcome.get("unscored") is True or outcome["reward"] is None:
                unscored_episodes += 1
            elif outcome["reward"] == 1.0:
                scored_successes += 1
            else:
                scored_failures += 1
            outcome=seal_row(outcome,previous_record_sha256)
            previous_record_sha256=outcome["record_sha256"]
            log.write(json.dumps(outcome, ensure_ascii=True) + "\n")
            log.flush()
            print("META_MECORD_EPISODE=" + json.dumps(outcome), flush=True)
            if campaign_stop:
                break
    print("META_MECORD_SUMMARY=" + json.dumps({
        "attempted":attempted_count,"scheduled":len(task_plan),
        "frozen_plan_sha256":frozen_plan_sha256,
        "global_campaign_sha256":global_plan_sha256,
        "harness_sha256":harness_sha256,"source_commit":source_commit,
        "runtime_manifest_sha256":runtime_manifest_sha256,
        "runtime_version":runtime_manifest_info.get("version"),
        "runtime_source_commit":runtime_manifest_info.get("sourceCommit"),
        "start_at":args.start_at,"count":len(task_plan),"campaign_tag":args.campaign_tag,
        "task_debug":task_debug,"qualification_eligible":not task_debug,
        "scored":scored_successes+scored_failures,
        "successes":scored_successes,"failures":scored_failures,
        "unscored":unscored_episodes,
        "success_rate_scored":(scored_successes/(scored_successes+scored_failures)
            if scored_successes+scored_failures else None),
        "status":"COMPLETE" if not campaign_stop and attempted_count==len(task_plan) and unscored_episodes==0 else "PARTIAL",
        "full_50_task_70_percent_gate":("PASS" if scored_successes>=35 else "FAIL")
            if not task_debug and args.limit==50 and args.workers==1 and args.count is None and args.start_at==0
            and attempted_count==50 and unscored_episodes==0 and not campaign_stop else "NOT_RUN",
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
    pass  # No persistent workspace lock; budget ledger handles its own release
