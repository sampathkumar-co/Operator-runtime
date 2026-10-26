"""Pure, offline source-contract tests. No model, Chromium, network or credentials."""
import unittest

from controller import (
    ControllerError, Decision, classify_error, model_prompt,
    normalize_decision, observed_candidates, safe_attempt,
)

GOOD = {"axtree_object": {"nodes": [
    {"browsergym_id": "1", "role": {"value": "button"}, "name": {"value": "Proceed"}},
    {"browsergym_id": "2", "role": {"value": "textbox"}, "name": {"value": "Comment"}},
    {"browsergym_id": "3", "role": {"value": "button"}, "name": {"value": "Proceed"}},
]}}


class SourceOnlyPolicy(unittest.TestCase):
    def setUp(self):
        self.candidates = observed_candidates(GOOD)

    def test_ambiguous_name_is_not_an_action(self):
        with self.assertRaisesRegex(ControllerError, "AMBIGUOUS"):
            normalize_decision({"op": "click", "target_name": "Proceed"}, self.candidates)

    def test_not_an_observed_id_never_accepted(self):
        for raw in [
            {"op": "click", "bid": "999"},
            {"op": "click", "bid": ["1"]},
            {"op": "click", "bid": 1},
            {"op": "click", "bid": {"__str__": "1"}},
            {"op": "click", "bid": "dom8", "css": "button"},
        ]:
            with self.subTest(raw=raw), self.assertRaises(ControllerError):
                normalize_decision(raw, self.candidates)

    def test_executable_or_boolean_model_values_rejected(self):
        class Spoof:
            def __str__(self):
                raise AssertionError("untrusted coercion executed")
        for raw in [
            {"op": Spoof(), "bid": "1"},
            {"op": "click", "bid": "1", "value": Spoof()},
            {"op": "type", "bid": "2", "value": 123},
            {"op": "key_press", "bid": "2", "key": Spoof()},
            {"op": "click", "bid": "1", "key": True},
            ["click", "1"],
        ]:
            with self.subTest(raw=type(raw).__name__), self.assertRaises(ControllerError):
                normalize_decision(raw, self.candidates)

    def test_duplicate_candidates_denied(self):
        with self.assertRaisesRegex(ControllerError, "AMBIGUOUS"):
            normalize_decision({"op": "click", "bid": "1"}, self.candidates + self.candidates)

    def test_uncertain_outcome_blocks_other_actions_including_wait(self):
        for error in ("RELAY_RESULT_UNCERTAIN", "RECOVERY_RECONCILIATION_REQUIRED"):
            self.assertEqual(classify_error(error), "stop_uncertain")
            self.assertFalse(safe_attempt(Decision("click", "1"), [{"error": error}]))
            self.assertFalse(safe_attempt(Decision("wait"), [{"error": error}]))
        self.assertFalse(safe_attempt(
            Decision("click", "1"), [{"op": "hover", "sideEffectState": "uncertain"}]))
        self.assertTrue(safe_attempt(Decision("click", "1"), [{"op": "hover"}]))

    def test_invalid_accessibility_bounds(self):
        for observation in (
            {},
            {"axtree_object": {"nodes": [{}] * 10001}},
            {"axtree_object": {"nodes": "forged"}},
            {"axtree_object": {"nodes": []}},
        ):
            if observation == {} or observation.get("axtree_object", {}).get("nodes") == []:
                self.assertEqual(observed_candidates(observation), [])
            else:
                with self.assertRaises(ControllerError):
                    observed_candidates(observation)
        with self.assertRaises(ControllerError):
            observed_candidates(GOOD, limit=0)

    def test_no_nonstandard_dom_selection_or_negative_indexes(self):
        obs = {"dom_object": {"strings": ["html", "body"],
                              "documents": [{"nodes": {
                                  "parentIndex": [-1, 0],
                                  "nodeType": [1, 1],
                                  "nodeName": [0, 1],
                                  "nodeValue": [-1, -1],
                                  "attributes": [[], []],
                                  "isClickable": {"index": [-1, 1, 99999]}
                              }}]}}
        choices = observed_candidates(obs)
        self.assertEqual([c["bid"] for c in choices], ["dom1"])
        self.assertIn("body:nth-of-type(1)", choices[0]["css"])

    def test_multi_document_dom_requires_observed_frame_identity(self):
        doc = {"nodes": {
            "parentIndex": [-1], "nodeType": [1], "nodeName": [0],
            "nodeValue": [-1], "attributes": [[]],
            "isClickable": {"index": [0]}
        }}
        snapshot = {"dom_object": {"strings": ["button"], "documents": [doc, doc]}}
        self.assertEqual(observed_candidates(snapshot), [],
                         "A document-local selector must not identify multiple frames")

    def test_prompt_is_data_only_and_bounded(self):
        prompt = model_prompt("do something", self.candidates, [])
        self.assertIn("Do not claim completion", prompt)
        self.assertNotIn("MUSE_API_KEY", prompt)
        with self.assertRaises(ControllerError):
            model_prompt(4, self.candidates, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
