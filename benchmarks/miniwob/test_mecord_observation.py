import unittest
from mecord_observation import observed_mecord_candidates,verified_action,MecordObservationError
GEN="abc123-7"
def obs(controls=None,visuals=None):
    return {"ok":True,"provider":"browser.cdp","page":{"semantic":{"observationGeneration":GEN,
        "controls":[] if controls is None else controls,"visuals":[] if visuals is None else visuals}}}
def item(ref="b-abc123-7-1",role="button",name="Save",active=True,frame=0):
    return {"ref":ref,"role":role,"name":name,"actionable":active,"disabled":False,
            "context":{"frameDepth":frame},"geometry":{"x":2,"y":4,"width":50,"height":20}}
class Grounding(unittest.TestCase):
 def test_verified_control(self):
    candidates=observed_mecord_candidates(obs([item()]))
    self.assertEqual(candidates[0]["bid"],"b-abc123-7-1")
    self.assertEqual(verified_action({"op":"click","bid":candidates[0]["bid"]},candidates,[])["ref"],"b-abc123-7-1")
 def test_visual_fallback_only_if_actionable(self):
    v=item(ref="b-abc123-7-2",role="",name="Visual",active=True)
    self.assertEqual(len(observed_mecord_candidates(obs([], [v]))),1)
    v["actionable"]=False
    self.assertEqual(observed_mecord_candidates(obs([], [v])),[])
 def test_dedupe(self):
    x=item()
    self.assertEqual(len(observed_mecord_candidates(obs([x],[x]))),1)
 def test_forged_ref(self):
    with self.assertRaises(MecordObservationError):
     verified_action({"op":"click","bid":"b-abc123-7-999"},observed_mecord_candidates(obs([item()])),[])
 def test_stale_generation(self):
    self.assertEqual(observed_mecord_candidates(obs([item(ref="b-abc123-6-1")])),[])
 def test_other_frame_ref_not_assumed(self):
    self.assertEqual(observed_mecord_candidates(obs([item(frame=1)])),[])
 def test_disabled_or_occluded_filtered(self):
    a=item();a["actionable"]=False
    self.assertEqual(observed_mecord_candidates(obs([a])),[])
    a=item();a["disabled"]=True
    self.assertEqual(observed_mecord_candidates(obs([a])),[])
 def test_uncertain_blocks_new_action(self):
    with self.assertRaises(MecordObservationError):
     verified_action({"op":"click","bid":"b-abc123-7-1"},observed_mecord_candidates(obs([item()])),
        [{"error":"RELAY_ACTION_OUTCOME_UNCERTAIN"}])
 def test_ambiguous_name_rejected(self):
    cs=observed_mecord_candidates(obs([item(),item(ref="b-abc123-7-2")]))
    with self.assertRaises(MecordObservationError):
     verified_action({"op":"click","target_name":"Save"},cs,[])
 def test_malformed_not_authorized(self):
    for p in ({},{"ok":False,"provider":"browser.cdp"},{"ok":True,"provider":"fake","page":{}}):
     with self.assertRaises(MecordObservationError):observed_mecord_candidates(p)
 def test_geometry_missing_filtered(self):
    a=item();a.pop("geometry")
    self.assertEqual(observed_mecord_candidates(obs([a])),[])
 def test_key_not_user_executable(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaises(MecordObservationError):
     verified_action({"op":"eval","bid":"b-abc123-7-1"},cs,[])
 def test_repeated_effect_denied(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaises(MecordObservationError):
     verified_action({"op":"click","bid":"b-abc123-7-1"},cs,
       [{"op":"click","bid":"b-abc123-7-1","value":""}]*2)
if __name__=="__main__":unittest.main(verbosity=2)
