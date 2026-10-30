import unittest
import urllib.error
from integration.model_failures import classify_episode_failure
from mecord_observation import MecordObservationError

class ClassificationTests(unittest.TestCase):
 def test_infrastructure_and_billing_stop_unscored(self):
  for text in ("MODEL_USAGE_MISSING_OR_INVALID","MODEL_ACCOUNTING_EXCEEDS_RESERVATION",
    "BUDGET_CAP_REACHED","META_HTTP_429","META_HTTP_400_SCHEMA",
    "MECORD_EXECUTION_STATE_UNCERTAIN","LOCAL_BRIDGE_TRANSPORT_TimeoutError",
    "MECORD_VISION_UNAVAILABLE","NO_MECORD_GROUNDED_TARGETS","SCREENSHOT_INPUT_INVALID"):
   kind,unscored,stop=classify_episode_failure(RuntimeError(text))
   self.assertTrue(unscored,text)
   self.assertIsNotNone(stop,text)
  self.assertEqual(classify_episode_failure(urllib.error.URLError("lost"))[1],True)
 def test_model_decision_can_fail_as_task_after_independent_reward(self):
  for error in (MecordObservationError("INVALID_TARGET"),RuntimeError("MODEL_RESPONSE_INCOMPLETE")):
   kind,unscored,stop=classify_episode_failure(error)
   self.assertEqual((kind,unscored,stop),("MODEL_DECISION",False,None))
 def test_unknown_failure_cannot_be_called_task_failure(self):
  kind,unscored,stop=classify_episode_failure(ValueError("unexpected"))
  self.assertEqual((kind,unscored,stop),("HARNESS_OR_UNKNOWN",True,"HARNESS_UNEXPECTED_FAILURE"))
if __name__=="__main__":unittest.main()
