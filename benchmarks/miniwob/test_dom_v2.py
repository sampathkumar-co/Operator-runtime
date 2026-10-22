import unittest
from controller import observed_candidates, normalize_decision, ControllerError
class DOM(unittest.TestCase):
 def setUp(self):
  self.obs={"axtree_object":{"nodes":[]},"dom_object":{"strings":["#document","html","body","svg","text","2","1","class","label","alpha"],"documents":[{
   "nodes":{"parentIndex":[-1,0,1,2,3,3,4,5],
            "nodeType":[9,1,1,1,1,1,3,3],
            "nodeName":[0,1,2,3,4,4,4,4],
            "nodeValue":[-1,-1,-1,-1,-1,-1,5,6],
            "attributes":[[],[],[],[],[7,8],[7,9],[],[]],
            "isClickable":{"index":[4,5]}}}]}}
 def test_dom_candidates_have_grounded_text_and_selector(self):
  items=observed_candidates(self.obs)
  self.assertEqual([x["bid"] for x in items],["dom4","dom5"])
  self.assertEqual([x["name"] for x in items],["2","1"])
  self.assertIn("svg:nth-of-type(1)",items[0]["css"])
  self.assertIn("text:nth-of-type(2)",items[1]["css"])
 def test_dom_selector_is_selection_not_llm_css(self):
  a=observed_candidates(self.obs)
  self.assertEqual(normalize_decision({"op":"click","bid":"dom4"},a).bid,"dom4")
  with self.assertRaises(ControllerError):normalize_decision({"op":"click","bid":"dom999","css":"html"},a)
 def test_no_unbounded_exceptions(self):
  self.assertEqual(observed_candidates({"dom_object":{"documents":[{}]}}),[])
if __name__=="__main__":unittest.main()
