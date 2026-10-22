"""Integration test: observed-only browser refs, one-dispatch fence, unsupported operation denial."""
import os,json,subprocess,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent
b=Path(r"C:\Users\SAMPATH\AppData\Local\Temp\mecord-yc-benchmark-20261022")
os.environ["MINIWOB_URL"]=(b/"miniwob-plusplus"/"miniwob"/"html"/"miniwob").as_uri()+"/"
os.environ["PLAYWRIGHT_BROWSERS_PATH"]=str(b/"browsers")
os.environ["MECORD_BENCH_CDP_PORT"]="9368"
import browsergym.miniwob,gymnasium as gym
server=subprocess.Popen(["node","--experimental-strip-types",str(root/"bridge_native.mjs")],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
try:
  h=server.stdout.readline().strip()
  assert h.startswith("NATIVE_BRIDGE_PORT="),h
  port=int(h.split("=")[1])
  env=gym.make("browsergym/miniwob.click-test",headless=True)
  try:
    _,_=env.reset(seed=43)
    def post(route,payload):
      req=urllib.request.Request(f"http://127.0.0.1:{port}/{route}",data=json.dumps(payload).encode(),method="POST",headers={"Content-Type":"application/json"})
      try:
        with urllib.request.urlopen(req,timeout=26) as response:return response.status,json.load(response)
      except urllib.error.HTTPError as error:
        return error.code,json.loads(error.read().decode())
    status,state=post("inspect",{})
    assert status==200 and state["ok"]
    observed=[x for x in state["candidates"] if x["role"]=="button"]
    assert len(observed)==1
    id=observed[0]["id"];snap=state["snapshot"]
    checks=[
       ("unobserved",{"snapshot":snap,"op":"click","id":"e999"},400),
       ("navigation",{"snapshot":snap,"op":"navigate","id":id},400),
       ("forged_delta",{"snapshot":snap,"op":"drag","id":id,"deltaX":5001,"deltaY":0},400),
       ("invalid_destination",{"snapshot":snap,"op":"drag_between","id":id,"toId":"e999"},400)
    ]
    for name,payload,expected in checks:
      code,body=post("act",payload)
      assert code==expected,(name,code,body)
      assert not body.get("ok"),name
    code,act=post("act",{"snapshot":snap,"op":"click","id":id})
    assert code==200 and act["ok"] and act["provider"]=="browser.cdp",act
    code,replay=post("act",{"snapshot":snap,"op":"click","id":id})
    assert code==400 and replay["error"]=="STALE_OBSERVATION",replay
    _,reward,_,_,_=env.step("noop()")
    assert reward==1.0,reward
    print("NATIVE_BRIDGE_SAFETY=PASS 6 checks, MiniWoB reward 1.0",flush=True)
  finally:env.close()
finally:
 server.terminate()
 try:server.wait(timeout=4)
 except:server.kill()
