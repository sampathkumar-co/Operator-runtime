import unittest
from controller import ControllerError, observed_candidates, normalize_decision, model_prompt, classify_error, safe_attempt,Decision
EXAMPLE={"axtree_object":{"nodes":[
 {"browsergym_id":"10","role":{"value":"generic"},"name":{"value":""}},
 {"browsergym_id":"11","role":{"value":"button"},"name":{"value":"Save"}},
 {"browsergym_id":"12","role":{"value":"button"},"name":{"value":"Cancel"}},
 {"browsergym_id":"13","role":{"value":"textbox"},"name":{"value":"Email"}},
 {"browsergym_id":"13","role":{"value":"InlineTextBox"},"name":{"value":""}},
 {"browsergym_id":"14","role":{"value":"SvgRoot"},"name":{"value":""}}
]}}
class TestController(unittest.TestCase):
 def setUp(self):self.a=observed_candidates(EXAMPLE)
 def test_candidate_grounding(self):
  self.assertEqual([x["bid"] for x in self.a],["10","11","12","13","14"])
 def test_basic_action(self):self.assertEqual(normalize_decision({"op":"click","bid":"11"},self.a),Decision("click","11"))
 def test_name_grounded(self):self.assertEqual(normalize_decision({"op":"click","target_name":"save"},self.a).bid,"11")
 def test_model_hallucinated_target_blocked(self):
  with self.assertRaisesRegex(ControllerError,"UNOBSERVED"):normalize_decision({"op":"click","bid":"999"},self.a)
 def test_forged_op_blocked(self):
  with self.assertRaisesRegex(ControllerError,"UNSUPPORTED"):normalize_decision({"op":"evaluate_javascript","bid":"11"},self.a)
 def test_missing_text_rejected(self):
  with self.assertRaisesRegex(ControllerError,"MISSING_VALUE"):normalize_decision({"op":"type","bid":"13"},self.a)
 def test_fill_alias(self):
  self.assertEqual(normalize_decision({"op":"fill","bid":"13","value":"example@example.org"},self.a).op,"set_value")
 def test_wait_not_fabricated(self):self.assertEqual(normalize_decision({"op":"wait"},self.a),Decision("wait"))
 def test_capped_content(self):
  self.assertEqual(len(normalize_decision({"op":"type","bid":"13","value":"a"*10000},self.a).value),400)
 def test_uncertain_not_replayed(self):self.assertEqual(classify_error("RELAY_ACTION_OUTCOME_UNCERTAIN"),"stop_uncertain")
 def test_policy_not_bypassed(self):self.assertEqual(classify_error("POLICY_DENIED"),"stop_authority")
 def test_no_progress_reobserve(self):self.assertEqual(classify_error("BROWSER_NO_PROGRESS"),"reobserve")
 def test_repeated_identical_blocked(self):
  h=[{"op":"click","bid":"11","value":""}]*2
  self.assertFalse(safe_attempt(Decision("click","11"),h))
 def test_prompt_uses_real_candidates(self):
  p=model_prompt("Click Save",self.a,[])
  self.assertIn('"bid": "11"',p)
  self.assertNotIn("miniwob.click-test",p)
if __name__=="__main__":unittest.main(verbosity=2)
