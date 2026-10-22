"""Generic native-observation MiniWoB agent, evaluated through the real Mecord browser CDP provider.
No task-specific solving, no protected production relay, independently scored BrowserGym reward.
"""
import argparse,json,os,re,subprocess,time,urllib.request,urllib.error
from pathlib import Path
from ollama_legacy import ask as ollama_ask
root=Path(__file__).resolve().parent
p=argparse.ArgumentParser()
p.add_argument("--limit",type=int,default=12);p.add_argument("--seed",type=int,default=0)
p.add_argument("--worker",type=int,default=0);p.add_argument("--workers",type=int,default=1)
p.add_argument("--max-steps",type=int,default=10);p.add_argument("--cap-usd",type=float,default=.06)
p.add_argument("--backend",choices=("meta","ollama"),default="meta")
p.add_argument("--max-model-calls",type=int,default=250)
args=p.parse_args()
if not (1<=args.limit<=125 and 1<=args.workers<=4 and 0<=args.worker<args.workers and 1<=args.max_steps<=15 and .001<=args.cap_usd<=.2 and 1<=args.max_model_calls<=1000):raise RuntimeError("INVALID_BENCHMARK_LIMIT")
benchmark=Path(os.environ.get("MECORD_MINIWOB_ENV_DIR") or (Path.home()/"AppData"/"Local"/"Temp"/"mecord-yc-benchmark-20261022"))
os.environ["MINIWOB_URL"]=(benchmark/"miniwob-plusplus"/"miniwob"/"html"/"miniwob").as_uri()+"/"
os.environ["PLAYWRIGHT_BROWSERS_PATH"]=str(benchmark/"browsers")
os.environ["MECORD_BENCH_CDP_PORT"]=str(9360+args.worker)
import gymnasium as gym,browsergym.miniwob
key=None
if args.backend=="meta":
    lines=(Path.home()/"Documents"/"Mecord_API_Keys_Template.txt").read_text(encoding="utf-8-sig").splitlines()
    matches=[re.match(r"^\s*MUSE_API_KEY\s*[:=]\s*(.+)$",x) for x in lines];matches=[m for m in matches if m]
    if len(matches)!=1:raise RuntimeError("KEY_UNAVAILABLE")
    key=matches[0].group(1).strip().strip('"').strip("'")
    del lines,matches
    if len(key)<16:raise RuntimeError("KEY_INVALID")
allowed=("click","hover","set_value","type","select","select_date","key_press","drag","drag_by","drag_between","resize","scroll","click_relative","keyboard_text","format_text","select_text_range","wait")
schema={"type":"json_schema","json_schema":{"name":"mecord_native_browser_step","strict":True,"schema":{
 "type":"object","properties":{
 "op":{"type":"string","enum":list(allowed)},"id":{"type":"string"},"toId":{"type":"string"},"value":{"type":"string"},
 "key":{"type":"string"},"deltaX":{"type":"number"},"deltaY":{"type":"number"},
 "xRatio":{"type":"number"},"yRatio":{"type":"number"},"start":{"type":"integer"},"end":{"type":"integer"}},
 "required":["op","id","toId","value","key","deltaX","deltaY","xRatio","yRatio","start","end"],
 "additionalProperties":False}}}
stats={"calls":0,"in":0,"out":0,"cost":0.0}
def inference(goal,state,history,feedback):
    prompt=("You are operating an unfamiliar synthetic web task using Mecord's real browser inspection and actions. "
       "Select ONE next action solely from the current candidates. Never invent IDs. "
       "Supported ops include click,hover,set_value,type,select,select_date,key_press,drag,drag_by,drag_between,scroll,click_relative,keyboard_text,format_text,select_text_range,wait. "
       "Use drag_between with id/toId for drag-drop; drag or scroll with deltaX/deltaY (CSS pixels), "
       "click_relative with xRatio/yRatio in [0,1] on a candidate. "
       "For select_date use ISO YYYY-MM-DD. For unused JSON fields use empty string or 0. "
       "Do not claim success unless the independent evaluator verifies it. "
       "\nGOAL:"+str(goal)[:700]+"\nOBSERVED_CANDIDATES:"+json.dumps(state.get("candidates",[])[:85],ensure_ascii=True)[:12500]
       +"\nPAGE_TEXT:"+str(state.get("textExcerpt",""))[:850]
       +"\nRECENT_ACTIONS:"+json.dumps(history[-4:],ensure_ascii=True)[:900]+"\nFEEDBACK:"+feedback[:400])
    if stats["calls"]>=args.max_model_calls:raise RuntimeError("MODEL_CALLS_CEILING")
    if args.backend=="ollama":
        action,usage=ollama_ask(prompt,schema["json_schema"]["schema"],seed=args.seed)
        stats["calls"]+=1
        stats["in"]+=usage["input_tokens"];stats["out"]+=usage["output_tokens"]
        return action
    # Conservative reservation for Meta Contributor API charges.
    if stats["cost"]+((len(prompt)/2)*.10+3072*.20)/1e6 > args.cap_usd:raise RuntimeError("MODEL_BUDGET_CEILING")
    body={"model":"muse-spark-1.3-contributor","messages":[{"role":"user","content":prompt}],
          "response_format":schema,"max_tokens":3072}
    req=urllib.request.Request("https://api.meta.ai/v1/chat/completions",
       data=json.dumps(body).encode(),method="POST",
       headers={"Content-Type":"application/json","Authorization":"Bearer "+key})
    try:
        with urllib.request.urlopen(req,timeout=65) as response: data=json.load(response)
    except urllib.error.HTTPError as e:raise RuntimeError("MODEL_HTTP_"+str(e.code)) from None
    u=data.get("usage") or {};a=int(u.get("prompt_tokens") or 0);b=int(u.get("completion_tokens") or 0)
    stats["calls"]+=1;stats["in"]+=a;stats["out"]+=b;stats["cost"]+=(a*.10+b*.20)/1_000_000
    choice=(data.get("choices") or [{}])[0]
    if choice.get("finish_reason")!="stop":raise RuntimeError("MODEL_OUTPUT_INCOMPLETE")
    content=(choice.get("message") or {}).get("content") or "{}"
    act=json.loads(content)
    if not isinstance(act,dict):raise RuntimeError("MODEL_ACTION_NOT_OBJECT")
    return act
def post(port,endpoint,data={}):
    req=urllib.request.Request(f"http://127.0.0.1:{port}/{endpoint}",method="POST",
      headers={"Content-Type":"application/json"},data=json.dumps(data).encode())
    with urllib.request.urlopen(req,timeout=32) as response:return json.load(response)
tasks=sorted(x for x in gym.envs.registry if str(x).startswith("browsergym/miniwob."))
if len(tasks)!=125:raise RuntimeError("NOT_125_MINIWOB_TASKS")
indices=list(range(125)) if args.limit==125 else ([round(i*124/(args.limit-1)) for i in range(args.limit)] if args.limit>1 else [0])
selection=[(i,tasks[k]) for i,k in enumerate(indices) if i%args.workers==args.worker]
results=root/"results";results.mkdir(exist_ok=True)
dest=results/f"native_{args.limit}_seed{args.seed}_w{args.worker}of{args.workers}.jsonl"
if dest.exists():raise RuntimeError("RESULT_LOG_EXISTS")
server=subprocess.Popen(["node","--experimental-strip-types",str(root/"bridge_native.mjs")],
   stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
try:
    header=server.stdout.readline().strip()
    if not header.startswith("NATIVE_BRIDGE_PORT="):raise RuntimeError("BRIDGE_INIT_FAILED")
    port=int(header.split("=")[1])
    with dest.open("x",encoding="utf8") as log:
      for idx,task in selection:
        started=time.monotonic()
        calls_before=stats["calls"]
        outcome={"idx":idx,"task_id":task,"seed":args.seed,"backend":args.backend,"reward":0.0,"steps":0,"model_calls":0,
                 "mecord_calls":0,"error":None}
        env=None
        try:
          env=gym.make(task,headless=True)
          obs,info=env.reset(seed=args.seed)
          history=[]
          for step in range(args.max_steps):
            if time.monotonic()-started>135:raise RuntimeError("EPISODE_TIMEOUT")
            state=post(port,"inspect")
            if not state.get("ok"):raise RuntimeError("NATIVE_INSPECTION_FAILED")
            choices={x["id"] for x in state.get("candidates") or []}
            feedback="";decision=None
            for attempt in range(2):
              decision=inference(str(obs.get("goal") or ""),state,history,feedback)
              outcome["model_calls"]+=1
              op=str(decision.get("op") or "")
              if op=="wait" or op in allowed and str(decision.get("id")) in choices and (op!="drag_between" or str(decision.get("toId")) in choices):
                break
              feedback="That op or ID was not in current observed candidates. Choose a valid op/id."
              decision=None
            if decision is None:raise RuntimeError("INVALID_MODEL_ACTION")
            op=str(decision["op"])
            if op=="wait":
              obs,reward,done,trunc,info=env.step("noop()")
            else:
              prev=(op,str(decision.get("id")),str(decision.get("value"))[:90],str(decision.get("toId")))
              if [tuple(h.get("fingerprint",())) for h in history[-2:]].count(prev)>=2:
                raise RuntimeError("NO_PROGRESS_REPETITION")
              payload={k:decision[k] for k in ("op","id","toId","value","key","deltaX","deltaY","xRatio","yRatio","start","end") if k in decision}
              response=post(port,"act",{**payload,"snapshot":state["snapshot"]})
              outcome["mecord_calls"]+=1
              history.append({"fingerprint":prev,"op":op,"ok":response.get("ok"),"code":response.get("error")})
              if response.get("provider")!="browser.cdp":
                raise RuntimeError("NATIVE_PROVIDER_IDENTITY_FAILED")
              if not response.get("ok"):
                if response.get("sideEffectState")=="uncertain":
                    raise RuntimeError("STOP_UNCERTAIN_BROWSER_ACTION")
                # Do not replay a failed potentially mutating action.
                obs,reward,done,trunc,info=env.step("noop()")
              else:
                obs,reward,done,trunc,info=env.step("noop()")
            outcome["steps"]+=1;outcome["reward"]=float(reward)
            if done or trunc:break
        except Exception as e:outcome["error"]=type(e).__name__+":"+str(e)[:100]
        finally:
          if env:
            try:env.close()
            except:pass
        outcome["model_calls"]=stats["calls"]-calls_before
        outcome["elapsed_sec"]=round(time.monotonic()-started,2)
        outcome["cost_cumulative"]=round(stats["cost"],8) if args.backend=="meta" else None
        log.write(json.dumps(outcome,ensure_ascii=True)+"\n");log.flush()
        print("NATIVE_EPISODE="+json.dumps(outcome),flush=True)
    print("NATIVE_RUN_SUMMARY="+json.dumps({"task_count":len(selection),"model_calls":stats["calls"],
       "estimated_cost_usd":round(stats["cost"],8) if args.backend=="meta" else None,"cap_usd":args.cap_usd if args.backend=="meta" else None,"backend":args.backend,"path":str(dest)}),flush=True)
finally:
    server.terminate()
    try:server.wait(timeout=5)
    except:server.kill()
    key=None
