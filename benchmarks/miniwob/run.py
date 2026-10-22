"""Isolated, generic Meta -> restored Mecord provider -> BrowserGym MiniWoB.
No task-specific labels or answers. No public relay. Fails closed on uncertainty.
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, time, urllib.request, urllib.error
from pathlib import Path
from controller import observed_candidates, normalize_decision, model_prompt, classify_error, safe_attempt, ControllerError

ROOT=Path(__file__).resolve().parent
BENCH=Path(os.environ.get("MECORD_MINIWOB_ENV_DIR") or str(Path.home()/"AppData"/"Local"/"Temp"/"mecord-yc-benchmark-20261022"))
p=argparse.ArgumentParser()
p.add_argument("--limit",type=int,default=12)
p.add_argument("--seed",type=int,default=42)
p.add_argument("--max-steps",type=int,default=10)
p.add_argument("--worker",type=int,default=0)
p.add_argument("--workers",type=int,default=1)
p.add_argument("--cap-usd",type=float,default=.05)
p.add_argument("--max-output-tokens",type=int,default=2048)
a=p.parse_args()
if not (1<=a.limit<=125 and 1<=a.workers<=4 and 0<=a.worker<a.workers and 1<=a.max_steps<=12 and .001<=a.cap_usd<=.2 and 256<=a.max_output_tokens<=4096):
    raise RuntimeError("INVALID_BENCHMARK_LIMITS")
os.environ["MINIWOB_URL"]=(BENCH/"miniwob-plusplus"/"miniwob"/"html"/"miniwob").as_uri()+"/"
os.environ["PLAYWRIGHT_BROWSERS_PATH"]=str(BENCH/"browsers")
os.environ["MECORD_BENCH_CDP_PORT"]=str(9360+a.worker)
import gymnasium as gym
import browsergym.miniwob

records=(Path.home()/"Documents"/"Mecord_API_Keys_Template.txt").read_text(encoding="utf-8-sig").splitlines()
keys=[m.group(1).strip().strip('"').strip("'") for row in records if (m:=re.match(r"^\s*MUSE_API_KEY\s*[:=]\s*(.*)$",row))]
if len(keys)!=1 or not 16<=len(keys[0])<=400:raise RuntimeError("META_CREDENTIAL_UNAVAILABLE")
key=keys[0]
del keys,records
budget={"cost":0.0,"calls":0,"in":0,"out":0}
schema={"type":"json_schema","json_schema":{"name":"mecord_observed_browser_action","strict":True,"schema":{
 "type":"object","properties":{
  "op":{"type":"string","enum":["click","hover","set_value","type","select","key_press","wait"]},
  "bid":{"type":"string"},"value":{"type":"string"},"key":{"type":"string"},"target_name":{"type":"string"}},
 "required":["op","bid","value","key","target_name"],"additionalProperties":False}}}
def model(prompt):
    # Reserve a *conservative per-call* worst-case amount before dispatch.
    estimate=((len(prompt)/2.0)*.10+a.max_output_tokens*.20)/1e6
    if budget["cost"]+estimate > a.cap_usd:raise RuntimeError("MODEL_SPENDING_CAP")
    req=urllib.request.Request("https://api.meta.ai/v1/chat/completions",method="POST",
        headers={"Content-Type":"application/json","Authorization":"Bearer "+key},
        data=json.dumps({"model":"muse-spark-1.3-contributor",
                         "messages":[{"role":"user","content":prompt}],
                         "max_tokens":a.max_output_tokens,
                         "response_format":schema}).encode())
    try:
        with urllib.request.urlopen(req,timeout=65) as resp:
            data=json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError("MODEL_HTTP_"+str(e.code)) from None
    usage=data.get("usage") or {}
    tin=int(usage.get("prompt_tokens") or 0);tout=int(usage.get("completion_tokens") or 0)
    budget["calls"]+=1;budget["in"]+=tin;budget["out"]+=tout
    budget["cost"]+=(tin*.10+tout*.20)/1000000
    choices=data.get("choices") or []
    if not choices:return {}, "NO_CHOICE"
    item=choices[0]
    if item.get("finish_reason")!="stop":return {}, "INCOMPLETE"
    raw=(item.get("message") or {}).get("content") or ""
    try:parsed=json.loads(raw)
    except (json.JSONDecodeError,TypeError):return {}, "NOT_JSON"
    return parsed, "ok"
def call(port,payload):
    req=urllib.request.Request(f"http://127.0.0.1:{port}/execute",method="POST",
         headers={"Content-Type":"application/json"},data=json.dumps(payload).encode())
    with urllib.request.urlopen(req,timeout=28) as resp:return json.load(resp)

all_tasks=sorted(str(x) for x in gym.envs.registry if str(x).startswith("browsergym/miniwob."))
if len(all_tasks)!=125:raise RuntimeError("TASK_REGISTRY_MISMATCH")
indices=list(range(125)) if a.limit==125 else ([round(i*124/(a.limit-1)) for i in range(a.limit)] if a.limit>1 else [0])
selected=[(i,all_tasks[idx]) for i,idx in enumerate(indices) if i%a.workers==a.worker]
outdir=ROOT/"results";outdir.mkdir(parents=True,exist_ok=True)
output=outdir/f"restored_meta_v2_{a.limit}_seed{a.seed}_w{a.worker}of{a.workers}.jsonl"
if output.exists():raise RuntimeError("REFUSE_OVERWRITE_EXISTING_EVIDENCE")
bridge=subprocess.Popen(["node","--experimental-strip-types",str(ROOT/"bridge.mjs")],
                        stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
try:
    first=bridge.stdout.readline().strip()
    if not first.startswith("MECORD_BRIDGE_PORT="):raise RuntimeError("BRIDGE_INIT_FAILED")
    bridgeport=int(first.split("=")[-1])
    with output.open("x",encoding="utf8") as stream:
      for idx,task_id in selected:
        started=time.monotonic()
        result={"idx":idx,"task_id":task_id,"seed":a.seed,"reward":0.0,"steps":0,
                "mecord_operations":0,"model_calls":0,"error":None}
        env=None
        try:
          env=gym.make(task_id,headless=True)
          obs,_=env.reset(seed=a.seed)
          history=[]
          for step in range(a.max_steps):
            if time.monotonic()-started>135:raise RuntimeError("TASK_TIME_LIMIT")
            candidates=observed_candidates(obs)
            if not candidates:raise RuntimeError("NO_OBSERVED_ELEMENTS")
            goal=str(obs.get("goal") or "")
            feedback=""
            decision=None
            # One bounded repair of a malformed or ungrounded model decision.
            for attempt in range(2):
              raw,status=model(model_prompt(goal,candidates,history,feedback=feedback))
              result["model_calls"]+=1
              if status!="ok":
                feedback="Model response was "+status+"; return a complete valid JSON action."
                continue
              try:
                decision=normalize_decision(raw,candidates)
                break
              except ControllerError as e:
                feedback="Invalid action: "+str(e)+". Select one current numeric bid or wait."
            if decision is None:raise RuntimeError("MODEL_ACTION_REPAIR_EXHAUSTED")
            if not safe_attempt(decision,history):raise RuntimeError("REPEATED_NO_PROGRESS")
            if decision.op=="wait":
              history.append({"op":"wait","reason":"explicit-model-wait"})
              obs,reward,done,truncated,_=env.step("noop()")
            else:
              action={"op":decision.op,"bid":decision.bid}
              match=next(x for x in candidates if x["bid"]==decision.bid)
              if "css" in match:action["css"]=match["css"]
              if decision.op in {"set_value","type","select"}:action["value"]=decision.value
              if decision.op=="key_press":action["key"]=decision.key
              response=call(bridgeport,action)
              result["mecord_operations"]+=1
              history.append({"op":decision.op,"bid":decision.bid,"value":decision.value[:80],
                              "ok":response.get("ok"),"error":response.get("error"),
                              "provider":response.get("provider")})
              if response.get("provider")!="browser.cdp":
                raise RuntimeError("PROVIDER_IDENTITY_MISMATCH")
              if not response.get("ok"):
                verdict=classify_error(response.get("error") or "")
                if verdict in {"stop_uncertain","stop_authority"}:
                    raise RuntimeError("STOP_"+verdict.upper())
                # Never automatically replay the same uncertain or potentially mutating action.
                # Reobserve only after this terminal failed attempt in a new decision iteration.
                if verdict not in {"reobserve","reobserve_no_replay"}:
                    raise RuntimeError("PROVIDER_"+str(response.get("error") or "UNKNOWN"))
                obs,reward,done,truncated,_=env.step("noop()")
                result["steps"]+=1
                if done or truncated:break
                continue
              obs,reward,done,truncated,_=env.step("noop()")
            result["steps"]+=1
            result["reward"]=float(reward)
            if done or truncated:break
        except Exception as e:
          result["error"]=type(e).__name__+":"+str(e)[:150]
        finally:
          if env:
            try:env.close()
            except:pass
        result["elapsed_s"]=round(time.monotonic()-started,2)
        result["cumulative_cost_usd"]=round(budget["cost"],8)
        stream.write(json.dumps(result,ensure_ascii=True)+"\n");stream.flush()
        print("RESTORE_EPISODE="+json.dumps(result),flush=True)
    print("RESTORE_SUMMARY="+json.dumps({
      "count":len(selected),"success":sum(json.loads(x)["reward"]==1 for x in output.read_text(encoding="utf8").splitlines()),
      "model_calls":budget["calls"],"estimated_cost_usd":round(budget["cost"],8),
      "cost_cap_usd":a.cap_usd,"path":str(output),
      "model":"muse-spark-1.3-contributor","provider":"Mecord historical browser.cdp source 7c9b0777"}),flush=True)
finally:
    bridge.terminate()
    try:bridge.wait(timeout=4)
    except:bridge.kill()
    key=None
