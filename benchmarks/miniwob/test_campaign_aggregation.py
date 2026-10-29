import json
import tempfile
import unittest
from pathlib import Path
from hashlib import sha256
from integration.aggregate_campaign import aggregate,CampaignError

class CampaignAggregation(unittest.TestCase):
 def make_campaign(self,folder,expected=8,workers=4):
    tasks=[(i,f"browsergym/miniwob.synthetic-{i}") for i in range(expected)]
    digest=sha256(json.dumps(tasks,separators=(",",":"),ensure_ascii=True).encode()).hexdigest()
    paths=[]
    for w in range(workers):
     path=folder/f"worker-{w}.jsonl"
     rows=[{"plan_index":i,"task_id":task,"worker":w,"workers":workers,"seed":42,
       "global_campaign_sha256":digest,"reward":1.0 if i%2==0 else 0.0}
       for i,task in tasks if i%workers==w]
     path.write_text("".join(json.dumps(x)+"\n" for x in rows))
     paths.append(path)
    return paths
 def test_exact_manifest_scored_across_four_workers(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     out=aggregate(paths,8,42,4)
     self.assertEqual(out["scored"],8)
     self.assertEqual(out["successes"],4)
     self.assertEqual(out["gate_70_percent"],"NOT_EVALUATED")
 def test_missing_worker_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     with self.assertRaises(CampaignError):aggregate(paths[:3],8,42,4)
 def test_duplicate_task_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records.append(records[0])
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     with self.assertRaises(CampaignError):aggregate(paths,8,42,4)
 def test_manifest_forgery_fails_closed(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records[0]["task_id"]="browsergym/miniwob.changed"
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     with self.assertRaises(CampaignError):aggregate(paths,8,42,4)
 def test_unscored_episode_not_a_success(self):
    with tempfile.TemporaryDirectory() as d:
     paths=self.make_campaign(Path(d))
     records=[json.loads(x) for x in paths[0].read_text().splitlines()]
     records[0]["unscored"]=True
     records[0]["reward"]=None
     paths[0].write_text("".join(json.dumps(x)+"\n" for x in records))
     out=aggregate(paths,8,42,4)
     self.assertEqual(out["unscored"],1)
     self.assertEqual(out["qualification"],"UNSCORED_EPISODES_PRESENT")

if __name__=="__main__":unittest.main()
