import unittest

from audit_results import BenchmarkAuditError, audit_results


SHA = "a" * 40
ROSTER = ["click-task", "type-task", "drag-task"]
def episode(task, reward, *, seed=42, source_sha=SHA, model_id="fixed-synthetic"):
    return {
        "task_id": task, "seed": seed, "source_sha": source_sha,
        "model_id": model_id, "independent_scorer_reward": reward,
        "model_calls": 1
    }


class ReportOnlyAudit(unittest.TestCase):
    def test_all_expected_tasks_counted_without_certifying_official_scorer(self):
        report = audit_results([
            episode("click-task", 1), episode("type-task", 0),
            episode("drag-task", 0.5),
        ], ROSTER, seed=42, source_sha=SHA, model_id="fixed-synthetic")
        self.assertEqual(report["task_count"], 3)
        self.assertEqual(report["successes"], 1)
        self.assertEqual(report["failures"], 2)
        self.assertEqual(report["model_calls"], 3)
        self.assertEqual(report["status"], "UNVERIFIED_SOURCE_ONLY")
        self.assertFalse(report["independent_scorer_authenticated"])
        self.assertFalse(report["physical_execution_verified"])

    def test_missing_failures_never_inflate_accuracy(self):
        with self.assertRaisesRegex(BenchmarkAuditError, "ROSTER_INCOMPLETE"):
            audit_results([episode("click-task", 1)], ROSTER,
                          seed=42, source_sha=SHA, model_id="fixed-synthetic")

    def test_duplicate_and_unknown_tasks_denied(self):
        for records in [
            [episode("click-task", 1), episode("click-task", 1)],
            [episode("invented", 1)],
        ]:
            with self.assertRaises(BenchmarkAuditError):
                audit_results(records, ROSTER, seed=42,
                              source_sha=SHA, model_id="fixed-synthetic")

    def test_context_must_match_exact_pinned_baseline(self):
        for modified in [
            episode("click-task", 1, seed=43),
            episode("click-task", 1, source_sha="b" * 40),
            episode("click-task", 1, model_id="other-model"),
        ]:
            with self.assertRaisesRegex(BenchmarkAuditError, "CONTEXT_MISMATCH"):
                audit_results([modified], ["click-task"], seed=42,
                              source_sha=SHA, model_id="fixed-synthetic")

    def test_malformed_rewards_cannot_claim_success(self):
        for bad in [True, "1", -1, 1.0000001, float("nan"), float("inf"), None]:
            with self.subTest(bad=bad), self.assertRaisesRegex(
                BenchmarkAuditError, "SCORER_REWARD_INVALID"
            ):
                audit_results([episode("click-task", bad)], ["click-task"],
                              seed=42, source_sha=SHA, model_id="fixed-synthetic")

    def test_untrusted_record_keys_and_boolean_calls_denied(self):
        entry = episode("click-task", 1)
        for modified in [
            {**entry, "verified": True},
            {**entry, "model_calls": True},
            {**entry, "model_calls": "1"},
        ]:
            with self.assertRaises(BenchmarkAuditError):
                audit_results([modified], ["click-task"], seed=42,
                              source_sha=SHA, model_id="fixed-synthetic")

    def test_duplicate_task_roster_or_forged_source_sha_denied(self):
        with self.assertRaisesRegex(BenchmarkAuditError, "DUPLICATE_EXPECTED_TASK"):
            audit_results([], ["click-task", "click-task"], seed=42,
                          source_sha=SHA, model_id="fixed-synthetic")
        with self.assertRaisesRegex(BenchmarkAuditError, "AUDIT_CONFIGURATION_INVALID"):
            audit_results([], ["click-task"], seed=42,
                          source_sha="not-a-pinned-sha", model_id="fixed-synthetic")


if __name__ == "__main__":
    unittest.main(verbosity=2)
