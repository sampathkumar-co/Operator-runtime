import unittest
from integration.campaign_plan import plan_tasks

ROSTER=["browsergym/miniwob.synthetic%03d"%i for i in range(125)]
class CampaignPlanTests(unittest.TestCase):
 def test_exact_frozen_50_worker_shards(self):
  all_seen=set()
  for worker in range(4):
   full,shard,debug=plan_tasks(ROSTER,50,4,worker)
   self.assertFalse(debug)
   self.assertEqual(len(full),50)
   self.assertTrue(all(i%4==worker for i,_ in shard))
   self.assertFalse(all_seen.intersection(i for i,_ in shard))
   all_seen.update(i for i,_ in shard)
  self.assertEqual(all_seen,set(range(50)))
 def test_single_task_debug_is_index_zero_never_accidental_125_index(self):
  plan,shard,debug=plan_tasks(ROSTER,50,1,0,ROSTER[117])
  self.assertTrue(debug)
  self.assertEqual(plan,[(0,ROSTER[117])])
  self.assertEqual(shard,plan)
 def test_debug_cannot_be_multiworker_or_unknown(self):
  for args in ((50,4,0,ROSTER[4]),(12,1,0,"browsergym/miniwob.fake")):
   with self.assertRaisesRegex(ValueError,"SINGLE_TASK_DEBUG_INVALID"):
    plan_tasks(ROSTER,*args)
 def test_invalid_roster_fails_closed(self):
  for roster in (ROSTER[:124],ROSTER[:-1]+[ROSTER[0]],[]):
   with self.assertRaises(ValueError):plan_tasks(roster,50,1,0)
if __name__=="__main__":unittest.main()
