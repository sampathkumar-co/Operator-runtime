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
    with self.assertRaisesRegex(MecordObservationError,"EXACT_OBSERVED_REF"):
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
    with self.assertRaisesRegex(MecordObservationError,"UNSUPPORTED_MODEL_FIELDS"):
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
 def test_observed_svg_nonactionable_relative(self):
    svg=item(ref="b-abc123-7-3",active=False)
    svg["tag"]="text"
    choices=observed_mecord_candidates(obs([], [svg]))
    self.assertEqual(len(choices),1)
    self.assertEqual(choices[0]["description"],"visual-geometry")
    self.assertEqual(verified_action({"op":"click_relative","bid":"b-abc123-7-3"},choices,[])["op"],"click_relative")
 def test_visual_regular_click_denied(self):
    svg=item(ref="b-abc123-7-3",active=False);svg["tag"]="text"
    choices=observed_mecord_candidates(obs([], [svg]))
    with self.assertRaisesRegex(MecordObservationError,"VISUAL_NEEDS_RELATIVE"):
     verified_action({"op":"click","bid":"b-abc123-7-3"},choices,[])
 def test_relative_nonvisual_denied(self):
    choices=observed_mecord_candidates(obs([item()]))
    with self.assertRaisesRegex(MecordObservationError,"RELATIVE_TARGET_NOT_VISUAL"):
     verified_action({"op":"click_relative","bid":"b-abc123-7-1"},choices,[])
 def test_visual_unknown_shape_denied(self):
    svg=item(ref="b-abc123-7-3",active=False);svg["tag"]="iframe"
    self.assertEqual(observed_mecord_candidates(obs([], [svg])),[])
 def test_svg_generation_still_checked(self):
    svg=item(ref="b-abc123-6-1",active=False);svg["tag"]="text"
    self.assertEqual(observed_mecord_candidates(obs([], [svg])),[])

 def test_no_accessible_name_fallback_after_stale_id(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaisesRegex(MecordObservationError,"UNSUPPORTED_MODEL_FIELDS"):
     verified_action({"op":"click","bid":"b-abc123-6-1","target_name":"Save"},cs,[])
 def test_unobserved_raw_css_and_coordinates_denied(self):
    cs=observed_mecord_candidates(obs([item()]))
    for extra in ({"css":"#save"},{"xRatio":0.5},{"target":{"ref":"b-abc123-7-1"}}):
     with self.assertRaisesRegex(MecordObservationError,"UNSUPPORTED_MODEL_FIELDS"):
      verified_action({"op":"click","bid":"b-abc123-7-1",**extra},cs,[])
 def test_uncertain_history_older_than_last_three_blocks(self):
    cs=observed_mecord_candidates(obs([item()]))
    history=[{"error":"RELAY_OUTCOME_UNCERTAIN"}]+[{"op":"hover","bid":"z"}]*5
    with self.assertRaisesRegex(MecordObservationError,"UNCERTAIN_HISTORY"):
     verified_action({"op":"click","bid":"b-abc123-7-1"},cs,history)
 def test_relative_click_must_use_exact_observed_svg(self):
    svg=item(ref="b-abc123-7-3",active=False);svg["tag"]="text"
    cs=observed_mecord_candidates(obs([], [svg]))
    with self.assertRaisesRegex(MecordObservationError,"EXACT_OBSERVED_REF"):
     verified_action({"op":"click_relative","bid":"b-abc123-7-99"},cs,[])

 def test_button_is_not_an_editor(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaisesRegex(MecordObservationError,"TARGET_NOT_EDITABLE"):
     verified_action({"op":"set_value","bid":"b-abc123-7-1","value":"hello"},cs,[])
 def test_textbox_can_be_filled(self):
    cs=observed_mecord_candidates(obs([item(role="textbox")]))
    self.assertEqual(verified_action({"op":"set_value","bid":"b-abc123-7-1","value":"hello"},cs,[])["op"],"set_value")
 def test_select_requires_selectable_role(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaisesRegex(MecordObservationError,"TARGET_NOT_SELECTABLE"):
     verified_action({"op":"select","bid":"b-abc123-7-1","value":"option"},cs,[])
 def test_observed_editable_generic_allowed(self):
    a=item(role="generic");a["editable"]=True
    cs=observed_mecord_candidates(obs([a]))
    self.assertEqual(verified_action({"op":"type","bid":"b-abc123-7-1","value":"a"},cs,[])["op"],"type")

 def test_native_date_input_accepts_real_iso_date(self):
    control=item(role="textbox");control["type"]="date"
    cs=observed_mecord_candidates(obs([control]))
    self.assertEqual(verified_action({"op":"select_date","bid":"b-abc123-7-1","value":"2026-10-29"},cs,[])["op"],"select_date")
 def test_date_does_not_allow_invalid_calendar_dates(self):
    control=item(role="textbox");control["type"]="date"
    cs=observed_mecord_candidates(obs([control]))
    for value in ("2026-02-30","29/10/2026","2026-2-9",""):
     with self.subTest(value=value),self.assertRaises(MecordObservationError):
      verified_action({"op":"select_date","bid":"b-abc123-7-1","value":value},cs,[])
 def test_date_action_rejects_non_date_input(self):
    cs=observed_mecord_candidates(obs([item(role="textbox")]))
    with self.assertRaisesRegex(MecordObservationError,"DATE_TARGET_NOT_DATE_INPUT"):
     verified_action({"op":"select_date","bid":"b-abc123-7-1","value":"2026-10-29"},cs,[])

 def test_scrollable_observed_control_accepts_bounded_direction(self):
    a=item(role="combobox");a["scrollable"]=True
    cs=observed_mecord_candidates(obs([a]))
    self.assertEqual(verified_action({"op":"scroll","bid":"b-abc123-7-1","value":"down"},cs,[])["value"],"down")
 def test_scroll_requires_observed_scrollable_and_exact_direction(self):
    cs=observed_mecord_candidates(obs([item()]))
    with self.assertRaisesRegex(MecordObservationError,"SCROLL_TARGET_OR_DIRECTION_INVALID"):
     verified_action({"op":"scroll","bid":"b-abc123-7-1","value":"down"},cs,[])
    a=item();a["scrollable"]=True
    cs=observed_mecord_candidates(obs([a]))
    with self.assertRaisesRegex(MecordObservationError,"SCROLL_TARGET_OR_DIRECTION_INVALID"):
     verified_action({"op":"scroll","bid":"b-abc123-7-1","value":"8000"},cs,[])
 def test_scrollable_nonclickable_visual_accepts_scroll_only(self):
    a=item(role="",active=False);a["tag"]="div";a["scrollable"]=True
    cs=observed_mecord_candidates(obs([], [a]))
    self.assertEqual(cs[0]["description"],"scroll-geometry")
    self.assertEqual(verified_action({"op":"scroll","bid":"b-abc123-7-1","value":"up"},cs,[])["op"],"scroll")
    with self.assertRaisesRegex(MecordObservationError,"SPECIALIST_ACTION_REQUIRED"):
     verified_action({"op":"click","bid":"b-abc123-7-1"},cs,[])
 def test_sortable_pair_same_observed_generation(self):
    first=item(role="",active=False);first["tag"]="div";first["groupRole"]="li";first["semanticPath"]="body>ul:sortable>li"
    second=dict(first,ref="b-abc123-7-2",name="Another")
    cs=observed_mecord_candidates(obs([], [first,second]))
    self.assertEqual(len(cs),2)
    self.assertEqual(verified_action({"op":"drag_between","bid":"b-abc123-7-1","value":"b-abc123-7-2"},cs,[])["op"],"drag_between")
    with self.assertRaisesRegex(MecordObservationError,"SPECIALIST_ACTION_REQUIRED"):
     verified_action({"op":"click","bid":"b-abc123-7-1"},cs,[])
 def test_sortable_disallows_unobserved_destination(self):
    first=item(role="",active=False);first["tag"]="div";first["groupRole"]="li";first["semanticPath"]="body>ul:sortable>li"
    cs=observed_mecord_candidates(obs([], [first]))
    with self.assertRaisesRegex(MecordObservationError,"DRAG_TARGETS_NOT_CURRENT_SORTABLE"):
     verified_action({"op":"drag_between","bid":"b-abc123-7-1","value":"b-abc123-7-9"},cs,[])
 def test_sortable_nonlist_elements_not_exposed(self):
    a=item(role="",active=False);a["tag"]="div";a["semanticPath"]="body>div"
    self.assertEqual(observed_mecord_candidates(obs([], [a])),[])
if __name__=="__main__":unittest.main(verbosity=2)
