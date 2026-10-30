import json, tempfile, unittest
from pathlib import Path
from aggregate_campaign import aggregate, frozen_plan, digest_plan, CampaignError, SOURCE_SHA, MODEL, EXECUTOR

ROSTER=["browsergym/miniwob.synthetic%03d"%i for i in range(125)]
HARNESS="a"*64
RUNTIME="b"*64
PLAN=frozen_plan(ROSTER,50)
MANIFEST=digest_plan(PLAN)
def episode(i,reward=1,**overrides):
    row={"worker":0,"workers":1,"seed":42,"plan_index":i,"task_id":PLAN[i][1],
         "reward":reward,"steps":1,"step_limit":6,"vision_enabled":False,
         "global_campaign_sha256":MANIFEST,"harness_sha256":HARNESS,
         "runtime_manifest_sha256":RUNTIME,"source_commit":SOURCE_SHA,
         "native_gestures_enabled":False,
         "agent":MODEL,"executor":EXECUTOR}
    row.update(overrides);return row
def file(folder,name,rows):
    path=folder/name
    path.write_text("".join(json.dumps(x)+"\n" for x in rows),encoding="utf8")
    return path

class Aggregation(unittest.TestCase):
 def test_partial_checkpoint_not_a_pass(self):
    with tempfile.TemporaryDirectory() as temp:
     result=aggregate([file(Path(temp),"partial.jsonl",[episode(i) for i in range(10)])],
                      50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     self.assertEqual(result["status"],"PARTIAL")
     self.assertEqual(result["gate_70_percent"],"NOT_EVALUATED")
     self.assertEqual(result["successes"],10)
     self.assertEqual(result["missing"],40)
 def test_five_disjoint_checkpoints_pass_35_of_50(self):
    with tempfile.TemporaryDirectory() as temp:
     files=[file(Path(temp),str(i)+".jsonl",
             [episode(j,1 if j<35 else 0) for j in range(i,i+10)]) for i in range(0,50,10)]
     result=aggregate(files,50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     self.assertEqual((result["status"],result["gate_70_percent"],result["successes"]),("COMPLETE","PASS",35))
 def test_34_of_50_fails(self):
    with tempfile.TemporaryDirectory() as temp:
     result=aggregate([file(Path(temp),"all",[episode(i,1 if i<34 else 0) for i in range(50)])],
                 50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     self.assertEqual(result["gate_70_percent"],"FAIL")
 def test_duplicate_or_different_revision_is_rejected(self):
    with tempfile.TemporaryDirectory() as temp:
     p=Path(temp)
     f=file(p,"a",[episode(0)])
     with self.assertRaisesRegex(CampaignError,"OVERLAPPING_CHECKPOINTS"):
      aggregate([f,file(p,"b",[episode(0)])],50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     with self.assertRaisesRegex(CampaignError,"HARNESS_OR_SOURCE_REVISION"):
      aggregate([file(p,"c",[episode(0,harness_sha256="b"*64)])],50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
 def test_canonical_task_and_unscored(self):
    with tempfile.TemporaryDirectory() as temp:
     p=Path(temp)
     with self.assertRaisesRegex(CampaignError,"TASK_NOT_IN_CANONICAL"):
      aggregate([file(p,"bad",[episode(0,task_id=PLAN[1][1])])],50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     f=file(p,"unscored",[episode(0,reward=None,unscored=True)])
     result=aggregate([f],50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)
     self.assertEqual((result["scored"],result["unscored"]),(0,1))
 def test_mixed_conditions_rejected(self):
    with tempfile.TemporaryDirectory() as temp:
     p=Path(temp)
     rows=[episode(0),episode(1,vision_enabled=True)]
     with self.assertRaisesRegex(CampaignError,"MIXED_TEST_CONDITIONS"):
      aggregate([file(p,"mixed",rows)],50,42,1,roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)


 def test_mixed_compiled_runtime_manifest_rejected(self):
    with tempfile.TemporaryDirectory() as temp:
     p=Path(temp)
     record=episode(0,runtime_manifest_sha256="c"*64)
     with self.assertRaisesRegex(CampaignError,"RUNTIME_MANIFEST_MISMATCH"):
      aggregate([file(p,"bad-runtime",[record])],50,42,1,
       roster=ROSTER,harness_sha256=HARNESS,runtime_manifest_sha256=RUNTIME)

if __name__=="__main__":unittest.main(verbosity=2)
