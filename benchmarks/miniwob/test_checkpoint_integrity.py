import unittest
from integration.checkpoint_integrity import seal_row, verify_file_rows, CheckpointIntegrityError, ZERO_DIGEST
class CheckpointTests(unittest.TestCase):
 def test_chained_rows_verify_in_order(self):
  first=seal_row({"task_id":"a","reward":0},ZERO_DIGEST)
  second=seal_row({"task_id":"b","reward":1},first["record_sha256"])
  self.assertEqual(verify_file_rows([first,second]),second["record_sha256"])
  with self.assertRaisesRegex(CheckpointIntegrityError,"CHAIN_INVALID"):
   verify_file_rows([second,first])
  with self.assertRaisesRegex(CheckpointIntegrityError,"CHAIN_INVALID"):
   verify_file_rows([dict(first,reward=1),second])
 def test_chain_is_not_authentication(self):
  first=seal_row({"reward":1})
  rewritten=seal_row({"reward":0})
  self.assertNotEqual(first["record_sha256"],rewritten["record_sha256"])
  self.assertTrue(verify_file_rows([rewritten]))
if __name__=="__main__":unittest.main()
