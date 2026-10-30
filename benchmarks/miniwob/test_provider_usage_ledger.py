import unittest,json,tempfile
from pathlib import Path
from integration.budget_ledger import BudgetLedger,BudgetError

class UsageLedgerTests(unittest.TestCase):
 def test_usage_record_does_not_refund_reservation(self):
  with tempfile.TemporaryDirectory() as root:
   ledger=BudgetLedger(root,lifetime_cap=.07,run_cap=.02,
                       worker=0,workers=1,manifest="a"*64)
   ledger.reserve(.01)
   ledger.record_reported_usage(reservation_usd=.01,prompt_tokens=1000,
                                completion_tokens=500,estimated_usd=.0002)
   rows=[json.loads(v) for v in (Path(root)/"mecord-provider-usage.jsonl").read_text().splitlines()]
   self.assertEqual(len(rows),1)
   self.assertEqual(rows[0]["prompt_tokens"],1000)
   self.assertEqual(ledger._sum(),.01)
   self.assertFalse((Path(root)/".mecord-budget.lock").exists())
 def test_overrun_or_invalid_usage_never_written(self):
  with tempfile.TemporaryDirectory() as root:
   ledger=BudgetLedger(root,lifetime_cap=.07,run_cap=.02,
                       worker=0,workers=1,manifest="a"*64)
   for params in ({"reservation_usd":.001,"prompt_tokens":10,
                   "completion_tokens":10,"estimated_usd":.01},
                  {"reservation_usd":.001,"prompt_tokens":True,
                   "completion_tokens":10,"estimated_usd":.0001}):
    with self.assertRaisesRegex(BudgetError,"REPORTED_USAGE_INVALID"):
     ledger.record_reported_usage(**params)
   self.assertFalse((Path(root)/"mecord-provider-usage.jsonl").exists())
if __name__=="__main__":unittest.main()
