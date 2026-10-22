import os, json, subprocess, urllib.request
from pathlib import Path
b=Path(r"C:\Users\SAMPATH\AppData\Local\Temp\mecord-yc-benchmark-20261022")
os.environ["MINIWOB_URL"]=(b/"miniwob-plusplus"/"miniwob"/"html"/"miniwob").as_uri()+"/"
os.environ["MECORD_BENCH_CDP_PORT"]="9367"
os.environ["PLAYWRIGHT_BROWSERS_PATH"]=str(b/"browsers")
import browsergym.miniwob, gymnasium as gym
server=subprocess.Popen(["node","--experimental-strip-types",str(Path(__file__).parent/"bridge_native.mjs")],
  stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
  line=server.stdout.readline().strip()
  if not line.startswith("NATIVE_BRIDGE_PORT="):
    raise RuntimeError("NATIVE_BRIDGE_LAUNCH_FAILED:"+line[:40])
  port=int(line.split("=")[1])
  env=gym.make("browsergym/miniwob.click-test",headless=True)
  try:
    obs,info=env.reset(seed=42)
    def call(route,payload={}):
      req=urllib.request.Request(f"http://127.0.0.1:{port}/{route}",data=json.dumps(payload).encode(),headers={"Content-Type":"application/json"},method="POST")
      with urllib.request.urlopen(req,timeout=22) as res:return json.load(res)
    state=call("inspect")
    print("NATIVE_INSPECT="+json.dumps({"ok":state.get("ok"),"candidates":len(state.get("candidates",[])),"sample":state.get("candidates",[])[:7],"visible":state.get("textExcerpt","")[:140]}),flush=True)
    buttons=[c for c in state.get("candidates",[]) if c.get("role")=="button"]
    if len(buttons)!=1:raise RuntimeError("SYNTHETIC_BUTTON_NOT_UNIQUE")
    act=call("act",{"snapshot":state["snapshot"],"op":"click","id":buttons[0]["id"]})
    obs,reward,done,trunc,info=env.step("noop()")
    print("NATIVE_SMOKE="+json.dumps({"provider":act.get("provider"),"success":act.get("ok"),"error":act.get("error"),"reward":float(reward)}),flush=True)
  finally:env.close()
finally:
  server.terminate()
  try:server.wait(timeout=4)
  except:server.kill()
