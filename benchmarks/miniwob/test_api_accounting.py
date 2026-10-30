import unittest
from integration.api_accounting import checked_reported_usage, ModelAccountingError

class AccountingTests(unittest.TestCase):
 def test_exact_integer_usage_under_reservation(self):
  row=checked_reported_usage({"prompt_tokens":1000,"completion_tokens":500},
       reservation_usd=.001)
  self.assertAlmostEqual(row["estimated_usage_usd"],.0002)
  self.assertGreater(row["unused_reservation_usd"],0)
 def test_billable_tokens_over_reservation_halt(self):
  with self.assertRaisesRegex(ModelAccountingError,"EXCEEDS_RESERVATION"):
   checked_reported_usage({"prompt_tokens":200000,"completion_tokens":0},
       reservation_usd=.005)
 def test_invalid_usage_denied_no_guessing(self):
  for value in (None,{},{"prompt_tokens":0,"completion_tokens":0},
                {"prompt_tokens":"100","completion_tokens":1},
                {"prompt_tokens":True,"completion_tokens":1},
                {"prompt_tokens":100,"completion_tokens":-1},
                {"prompt_tokens":1.5,"completion_tokens":0}):
   with self.assertRaises(ModelAccountingError):
    checked_reported_usage(value,reservation_usd=.01)
 def test_bad_reservation_fails(self):
  for value in (float("nan"),0,-1,True):
   with self.assertRaises(ModelAccountingError):
    checked_reported_usage({"prompt_tokens":10,"completion_tokens":1},
                           reservation_usd=value)
if __name__=="__main__":unittest.main()
