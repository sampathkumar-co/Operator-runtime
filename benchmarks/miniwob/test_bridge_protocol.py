import unittest
from integration.bridge_protocol import parse_bridge_http_rejection

class BridgeProtocolTests(unittest.TestCase):
    def test_pre_dispatch_no_effect_rejection_is_retryable(self):
        v=parse_bridge_http_rejection(400,{"error":"INVALID_VALUE","executionPhase":"pre_dispatch","sideEffectState":"none"})
        self.assertEqual(v["executionPhase"],"pre_dispatch")
        self.assertEqual(v["sideEffectState"],"none")
        self.assertFalse(v["ok"])
    def test_uncertain_or_auth_error_never_claims_no_side_effect(self):
        for code,detail in [(400,{"error":"AFTER","executionPhase":"dispatched","sideEffectState":"uncertain"}),
                            (403,{"error":"AUTH","executionPhase":"pre_dispatch","sideEffectState":"none"}),
                            (500,{"error":"UNKNOWN"}),(400,[])]:
            with self.subTest(code=code,detail=detail):
                v=parse_bridge_http_rejection(code,detail)
                self.assertIsNone(v["executionPhase"])
                self.assertIsNone(v["sideEffectState"])
if __name__=="__main__":
    unittest.main()
