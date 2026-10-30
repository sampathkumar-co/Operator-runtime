import unittest
from integration.model_failures import safe_meta_http_error,is_campaign_blocking_meta_failure

class ModelFailureTests(unittest.TestCase):
    def test_safe_error_code_only(self):
        raw=b'{"error":{"code":"invalid_request_error","message":"secret detail ignored"}}'
        self.assertEqual(safe_meta_http_error(400,raw),"META_HTTP_400_invalid_request_error")
        self.assertNotIn("secret",safe_meta_http_error(400,raw))
    def test_malformed_body_does_not_leak(self):
        self.assertEqual(safe_meta_http_error(429,b'not-json'),"META_HTTP_429")
    def test_provider_rejections_stop_without_faking_a_task_failure(self):
        for code in (400,401,403,408,422,429,500,503):
            self.assertTrue(is_campaign_blocking_meta_failure(f"META_HTTP_{code}"))
        for text in ("MODEL_RESPONSE_TRUNCATED","LOCAL_BRIDGE_TRANSPORT","META_HTTP_200","META_HTTP_404"):
            self.assertFalse(is_campaign_blocking_meta_failure(text))

if __name__=="__main__":
    unittest.main()
