import unittest,io,json
from ollama_legacy import MODEL,URL,make_request,ask
class Response:
 def __init__(self,data):self.fp=io.BytesIO(json.dumps(data).encode())
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,*args):return self.fp.read(*args)
class OllamaCompatibility(unittest.TestCase):
 def setUp(self):
  self.schema={"type":"object","properties":{"op":{"type":"string"}},"required":["op"],"additionalProperties":False}
 def test_fixed_historical_configuration(self):
  req=make_request("Synthetic test",self.schema,seed=0)
  self.assertEqual(req["model"],"gpt-oss:120b-cloud")
  self.assertFalse(req["think"]);self.assertFalse(req["stream"])
  self.assertEqual(req["options"],{"temperature":0,"num_ctx":8192,"num_predict":1536,"seed":0})
 def test_unsupported_schema_fails(self):
  with self.assertRaises(ValueError):make_request("x",{"type":"string"})
 def test_bounded_input(self):
  with self.assertRaises(ValueError):make_request("a"*40000,self.schema)
 def test_localhost_only_and_parse(self):
  def opener(request,timeout):
   self.assertEqual(request.full_url,"http://127.0.0.1:11434/api/chat")
   body=json.loads(request.data)
   self.assertEqual(body["format"],self.schema)
   return Response({"message":{"content":'{"op":"click"}'},"prompt_eval_count":200,"eval_count":55})
  action,usage=ask("Click observed button",self.schema,opener=opener)
  self.assertEqual(action,{"op":"click"})
  self.assertEqual(usage,{"input_tokens":200,"output_tokens":55})
if __name__=="__main__":unittest.main()
