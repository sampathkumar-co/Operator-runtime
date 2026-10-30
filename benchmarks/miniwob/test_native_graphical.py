import unittest
from mecord_observation import observed_mecord_candidates,verified_action,MecordObservationError

def observed():
    base={"ref":"b-abc123-7-1","role":"button","name":"Click Me!","tag":"button",
          "actionable":True,"disabled":False,
          "context":{"frameDepth":0},
          "geometry":{"x":5,"y":5,"width":180,"height":65}}
    canvas={"ref":"b-abc123-7-2","role":"canvas","name":"Drawing canvas","tag":"canvas",
            "actionable":False,"disabled":False,
            "context":{"frameDepth":0},
            "geometry":{"x":5,"y":80,"width":240,"height":145}}
    payload={"ok":True,"provider":"browser.cdp","page":{"semantic":{"observationGeneration":"abc123-7",
        "controls":[base],"visuals":[canvas]}}}
    return observed_mecord_candidates(payload)
class NativeGraphicalGrounding(unittest.TestCase):
    def test_unreleased_native_ops_disabled_by_default(self):
        items=observed()
        for name,value,ref in (("double_click","","b-abc123-7-1"),
                               ("shift_click","","b-abc123-7-1"),
                               ("drag_path","0.20:0.30;0.80:0.70","b-abc123-7-2")):
            with self.subTest(name=name),self.assertRaisesRegex(MecordObservationError,"NATIVE_GESTURES_REQUIRE_PINNED_SOURCE"):
                verified_action({"op":name,"bid":ref,"value":value},items,[])
    def test_native_ops_require_fresh_observed_refs(self):
        items=observed()
        for name,value,ref in (("double_click","","b-abc123-7-1"),
                               ("shift_click","","b-abc123-7-1"),
                               ("drag_path","0.20:0.30;0.80:0.70","b-abc123-7-2")):
            with self.subTest(name=name):
                action=verified_action({"op":name,"bid":ref,"value":value},items,[],native_enabled=True)
                self.assertEqual(action["op"],name)
                self.assertEqual(action["ref"],ref)
    def test_path_forgery_and_repeated_stroke_rejected(self):
        items=observed()
        for value in ("0.00:0.1;0.2:0.3","0.20:0.20;0.20:0.20","2:3;4:5",
                      "0.21:0.32","0.2:0.3;"*25):
            with self.subTest(value=value),self.assertRaises(MecordObservationError):
                verified_action({"op":"drag_path","bid":"b-abc123-7-2","value":value},items,[],native_enabled=True)
        with self.assertRaises(MecordObservationError):
            verified_action({"op":"drag_path","bid":"b-abc123-7-1","value":"0.20:0.20;0.50:0.50"},items,[],native_enabled=True)
    def test_nonactionable_double_click_rejected(self):
        with self.assertRaises(MecordObservationError):
            verified_action({"op":"double_click","bid":"b-abc123-7-2"},observed(),[],native_enabled=True)
if __name__=="__main__": unittest.main()
