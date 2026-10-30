import json
import tempfile
import unittest
from pathlib import Path
from hashlib import sha256
from integration.aggregate_campaign import (aggregate, CampaignError, frozen_plan,
    digest_plan, SOURCE_SHA, MODEL, EXECUTOR)
from integration.budget_ledger import BudgetLedger,BudgetError
from integration.checkpoint_integrity import seal_row,ZERO_DIGEST
from concurrent.futures import ThreadPoolExecutor

ROSTER=[f"browsergym/miniwob.synthetic-{i}" for i in range(125)]
HARNESS="a"*64
RUNTIME="b"*64

class CampaignAggregation(unittest.TestCase):
 def score(self, paths, expected=8, workers=4):
    return aggregate(paths, expected, 42, workers, roster=ROSTER,
                     harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
 def make_campaign(self,folder,expected=8,workers=4):
    tasks=frozen_plan(ROSTER,expected)
    digest=digest_plan(tasks)
    paths=[]
    for w in range(workers):
     path=folder/f"worker-{w}.jsonl"
     rows=[{"plan_index":i,"task_id":task,"worker":w,"workers":workers,"seed":42,
       "global_campaign_sha256":digest,"harness_sha256":HARNESS,
       "runtime_manifest_sha256":RUNTIME,
       "native_gestures_enabled":False,
       "source_commit":SOURCE_SHA,"agent":MODEL,"executor":EXECUTOR,
       "vision_enabled":False,"steps":1,"step_limit":6,
       "reward":1.0 if i%2==0 else 0.0}
       for i,task in tasks if i%workers==w]
     previous=ZERO_DIGEST
     sealed=[]
     for row in rows:
      record=seal_row(row,previous)
      previous=record["record_sha256"]
      sealed.append(record)
     path.write_text("".join(json.dumps(x)+"\n" for x in sealed))
     paths.append(path)
    return paths
 def test_exact_manifest_scored_across_four_workers(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     out=self.score(paths)
     self.assertEqual(out["scored"],8)
     self.assertEqual(out["successes"],4)
     self.assertEqual(out["gate_70_percent"],"NOT_EVALUATED")
 def test_missing_worker_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     out=self.score(paths[:3])
     self.assertEqual(out["status"],"PARTIAL")
     self.assertEqual(out["gate_70_percent"],"NOT_EVALUATED")
     self.assertIsNone(out["full_score"])
 def test_duplicate_task_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records.append(records[0])
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     with self.assertRaises(CampaignError):self.score(paths)
 def test_manifest_forgery_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records[0]["task_id"]="browsergym/miniwob.changed"
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     with self.assertRaises(CampaignError):self.score(paths)
 def test_unscored_episode_not_a_success(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records[0]["unscored"]=True
     records[0]["reward"]=None
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     previous=ZERO_DIGEST
     sealed=[]
     for row in records:
      fixed=seal_row(row,previous)
      previous=fixed["record_sha256"]
      sealed.append(fixed)
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in sealed))
     out=self.score(paths)
     self.assertEqual(out["unscored"],1)
     self.assertEqual(out["status"],"PARTIAL")
     self.assertIsNone(out["full_score"])


 def test_atomic_ledger_under_four_concurrent_workers(self):
    with tempfile.TemporaryDirectory() as d:
     folder=Path(d)
     ledgers=[BudgetLedger(folder,lifetime_cap=0.05,run_cap=0.03,
       worker=i,workers=4,manifest="a"*64) for i in range(4)]
     def work(ledger):
      successes=0
      for _ in range(5):
       try:
        ledger.reserve(0.003)
        successes+=1
       except BudgetError as err:
        self.assertEqual(str(err),"BUDGET_CAP_REACHED")
      return successes
     with ThreadPoolExecutor(max_workers=4) as pool:
      counts=list(pool.map(work,ledgers))
     data=[json.loads(s) for s in (folder/"mecord-api-reservations.jsonl").read_text().splitlines()]
     self.assertEqual(len(data),sum(counts))
     self.assertLessEqual(sum(row["usd"] for row in data),0.05+1e-9)
     self.assertFalse((folder/".mecord-budget.lock").exists())
if __name__=="__main__":unittest.main()
