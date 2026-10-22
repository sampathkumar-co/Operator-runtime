"""Legacy GPT-OSS benchmark model adapter; exact historical options, localhost Ollama only."""
from __future__ import annotations
import json,urllib.request,urllib.error
MODEL="gpt-oss:120b-cloud"
URL="http://127.0.0.1:11434/api/chat"
MAX_INPUT_BYTES=28_000
def make_request(prompt:str,action_schema:dict,*,seed:int=0)->dict:
    if len(prompt.encode("utf-8"))>MAX_INPUT_BYTES:
        raise ValueError("PROMPT_TOO_LARGE")
    if not isinstance(action_schema,dict) or action_schema.get("type")!="object":
        raise ValueError("ACTION_SCHEMA_INVALID")
    return {"model":MODEL,
        "messages":[{"role":"user","content":prompt}],
        "format":action_schema,
        "think":False,"stream":False,
        "options":{"temperature":0,"num_ctx":8192,"num_predict":1536,"seed":seed}}
def ask(prompt:str,action_schema:dict,*,seed:int=0,opener=None)->tuple[dict,dict]:
    payload=make_request(prompt,action_schema,seed=seed)
    request=urllib.request.Request(URL,data=json.dumps(payload).encode(),method="POST",
       headers={"Content-Type":"application/json"})
    call=opener or urllib.request.urlopen
    try:
        with call(request,timeout=75) as response:
            data=json.load(response)
    except urllib.error.HTTPError as e:
        raise RuntimeError("OLLAMA_HTTP_"+str(e.code)) from None
    message=(data.get("message") or {}).get("content")
    if not isinstance(message,str):
        raise RuntimeError("OLLAMA_RESPONSE_MISSING")
    action=json.loads(message)
    if not isinstance(action,dict):
        raise RuntimeError("OLLAMA_ACTION_NOT_OBJECT")
    usage={"input_tokens":int(data.get("prompt_eval_count") or 0),
            "output_tokens":int(data.get("eval_count") or 0)}
    return action,usage
