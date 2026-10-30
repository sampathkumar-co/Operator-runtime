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

 def test_stable_identity_denies_duplicate_across_fresh_refs(self):
    old=observed_mecord_candidates(obs([item()]))[0]
    new=observed_mecord_candidates(obs([item(ref="b-abc123-7-2")]))[0]
    self.assertEqual(old["identity"],new["identity"])
    with self.assertRaisesRegex(MecordObservationError,"UNSAFE_REPLAY_STABLE_TARGET"):
     verified_action({"op":"click","bid":new["bid"]},[new],
       [{"op":"click","bid":old["bid"],"identity":old["identity"],"value":""}]*2)
 def test_wait_without_target_and_wait_with_target_rejected(self):
    cs=observed_mecord_candidates(obs([item()]))
    self.assertEqual(verified_action({"op":"wait","bid":"","value":"","key":""},cs,[])["op"],"wait")
    with self.assertRaisesRegex(MecordObservationError,"WAIT_MUST_HAVE_NO_TARGET"):
     verified_action({"op":"wait","bid":cs[0]["bid"]},cs,[])
 def test_clear_textbox_to_empty_is_supported(self):
    cs=observed_mecord_candidates(obs([item(role="textbox")]))
    self.assertEqual(verified_action({"op":"set_value","bid":cs[0]["bid"],"value":""},cs,[])["value"],"")
 def test_observed_control_state_is_preserved(self):
    a=item(role="checkbox")
    a.update({"checked":True,"selected":False,"expanded":True,"value":"abc","placeholder":"Search"})
    c=observed_mecord_candidates(obs([a]))[0]
    self.assertIs(c["checked"],True)
    self.assertIs(c["selected"],False)
    self.assertEqual(c["currentValue"],"abc")
 def test_visuals_are_not_starved_by_many_controls(self):
    controls=[item(ref=f"b-abc123-7-{i+1}",name=f"Button {i}") for i in range(120)]
    visual=item(ref="b-abc123-7-z",role="",active=False)
    visual["tag"]="circle"
    cs=observed_mecord_candidates(obs(controls,[visual]),limit=90)
    self.assertEqual(len(cs),90)
    self.assertIn("b-abc123-7-z",[c["bid"] for c in cs])
 def test_large_bounded_scroll_and_invalid_scroll(self):
    a=item(role="combobox");a["scrollable"]=True
    cs=observed_mecord_candidates(obs([a]))
    self.assertEqual(verified_action({"op":"scroll","bid":cs[0]["bid"],"value":"down:320"},cs,[])["value"],"down:320")
    with self.assertRaisesRegex(MecordObservationError,"SCROLL_TARGET_OR_DIRECTION_INVALID"):
     verified_action({"op":"scroll","bid":cs[0]["bid"],"value":"down:2000"},cs,[])
 def test_bounded_extended_editing_and_displacement(self):
    cs=observed_mecord_candidates(obs([item(role="textbox")]))
    bid=cs[0]["bid"]
    for op,value in [("keyboard_text","hello"),("format_text","bold"),("select_text_range","1:3"),("drag_by","right:80"),("resize","down:40")]:
     with self.subTest(op=op):
      self.assertEqual(verified_action({"op":op,"bid":bid,"value":value},cs,[])["op"],op)
    with self.assertRaisesRegex(MecordObservationError,"DISPLACEMENT_INVALID"):
     verified_action({"op":"drag_by","bid":bid,"value":"right:2000"},cs,[])
 def test_hotkey_allowlist_and_rejection(self):
    cs=observed_mecord_candidates(obs([item()]))
    bid=cs[0]["bid"]
    self.assertEqual(verified_action({"op":"hotkey","bid":bid,"key":"CTRL+A"},cs,[])["key"],"CTRL+A")
    with self.assertRaisesRegex(MecordObservationError,"HOTKEY_INVALID"):
     verified_action({"op":"hotkey","bid":bid,"key":"CTRL+ALT+DELETE"},cs,[])

 def test_explicit_cross_origin_frame_generation(self):
    frame=item(ref="b-child01-4-1",role="button",name="Frame save")
    frame["observationGeneration"]="child01-4"
    frame["sourceFrameTargetId"]="synthetic-oopif"
    cs=observed_mecord_candidates(obs([frame]))
    self.assertEqual(len(cs),1)
    self.assertEqual(cs[0]["frameTargetId"],"synthetic-oopif")
    self.assertEqual(verified_action({"op":"click","bid":cs[0]["bid"]},cs,[])["op"],"click")
 def test_frame_generation_mismatch_fails_closed(self):
    frame=item(ref="b-invalid-3-1",role="button")
    frame["observationGeneration"]="child01-4"
    self.assertEqual(observed_mecord_candidates(obs([frame])),[])
 def test_cross_frame_drag_rejected_in_validator(self):
    first=item(role="",active=False);first.update({"tag":"div","groupRole":"li","semanticPath":"body>ul:sortable>li","observationGeneration":"abc123-7","sourceFrameTargetId":"a"})
    second=dict(first,ref="b-abc123-7-2",name="Another",sourceFrameTargetId="b")
    cs=observed_mecord_candidates(obs([], [first,second]))
    with self.assertRaisesRegex(MecordObservationError,"DRAG_TARGETS_NOT_CURRENT_SORTABLE"):
     verified_action({"op":"drag_between","bid":first["ref"],"value":second["ref"]},cs,[])
 def test_graphical_canvas_click_grid_validation(self):
    canvas=item(ref="b-abc123-7-3",role="",active=False)
    canvas["tag"]="canvas"
    cs=observed_mecord_candidates(obs([], [canvas]))
    self.assertEqual(verified_action({"op":"click_relative","bid":canvas["ref"],"value":"top-right"},cs,[])["value"],"top-right")
    with self.assertRaisesRegex(MecordObservationError,"RELATIVE_POINT_NOT_ENUMERATED"):
     verified_action({"op":"click_relative","bid":canvas["ref"],"value":"0.98,0.22"},cs,[])

 def test_provider_dialog_accept_dismiss_with_exact_ref(self):
    dialog_ref="bd-0123456789abcdef-1-0123456789ab"
    seen=observed_mecord_candidates({"ok":True,"provider":"browser.cdp",
      "dialog":{"ref":dialog_ref,"type":"prompt"}})
    self.assertEqual(seen[0]["bid"],dialog_ref)
    self.assertEqual(verified_action({"op":"dialog_accept","bid":dialog_ref,
      "value":"answer","key":""},seen,[])["value"],"answer")
    self.assertEqual(verified_action({"op":"dialog_dismiss","bid":dialog_ref,
      "value":"","key":""},seen,[])["op"],"dialog_dismiss")
 def test_dialog_forged_ref_and_prompt_policy_rejected(self):
    dialog_ref="bd-0123456789abcdef-1-0123456789ab"
    seen=observed_mecord_candidates({"ok":True,"provider":"browser.cdp",
      "dialog":{"ref":dialog_ref,"type":"confirm"}})
    with self.assertRaisesRegex(MecordObservationError,"EXACT_DIALOG_REF_REQUIRED"):
     verified_action({"op":"dialog_accept","bid":"bd-0123456789abcdef-2-0123456789ab"},seen,[])
    with self.assertRaisesRegex(MecordObservationError,"DIALOG_PROMPT_ONLY"):
     verified_action({"op":"dialog_accept","bid":dialog_ref,"value":"not allowed"},seen,[])
    with self.assertRaisesRegex(MecordObservationError,"DIALOG_PROMPT_ONLY"):
     verified_action({"op":"dialog_dismiss","bid":dialog_ref,"value":"not allowed"},seen,[])

 def test_dense_page_does_not_starve_authorized_frames(self):
    main=[item(ref=f"b-abc123-7-{i+1}",name=f"Main {i}") for i in range(100)]
    framed=item(ref="b-frame01-2-1",name="Inner button")
    framed["sourceFrameTargetId"]="observed-frame-1"
    framed["observationGeneration"]="frame01-2"
    cs=observed_mecord_candidates(obs(main+[framed]),limit=30)
    self.assertTrue(any(c["bid"]==framed["ref"] for c in cs))
 def test_general_graphical_drag_between_current_observed_elements(self):
    one=item(ref="b-abc123-7-11",active=False,name="Source")
    two=item(ref="b-abc123-7-12",active=False,name="Destination")
    one["tag"]=two["tag"]="canvas"
    cs=observed_mecord_candidates(obs([], [one,two]))
    self.assertEqual(verified_action({"op":"drag_to","bid":one["ref"],"value":two["ref"]},cs,[])["op"],"drag_to")
    self.assertEqual(verified_action({"op":"hover","bid":one["ref"]},cs,[])["op"],"hover")
    with self.assertRaisesRegex(MecordObservationError,"DRAG_TARGETS_NOT_CURRENT"):
     verified_action({"op":"drag_to","bid":one["ref"],"value":"b-abc123-7-999"},cs,[])
 def test_horizontal_scroll_and_diagonal_drag(self):
    scroll=item(role="listbox",active=False)
    scroll["scrollable"]=True
    scroll["tag"]="div"
    cs=observed_mecord_candidates(obs([], [scroll]))
    self.assertEqual(verified_action({"op":"scroll","bid":cs[0]["bid"],"value":"right:640"},cs,[])["value"],"right:640")
    draggable=item(ref="b-abc123-7-2")
    drag=observed_mecord_candidates(obs([draggable]))
    self.assertEqual(verified_action({"op":"drag_by","bid":draggable["ref"],"value":"up-right:20"},drag,[])["value"],"up-right:20")
 def test_precise_relative_click_and_invalid_ratio(self):
    graphic=item(active=False);graphic["tag"]="canvas"
    cs=observed_mecord_candidates(obs([], [graphic]))
    self.assertEqual(verified_action({"op":"click_relative","bid":graphic["ref"],"value":"0.27:0.83"},cs,[])["value"],"0.27:0.83")
    with self.assertRaisesRegex(MecordObservationError,"RELATIVE_POINT_NOT_ENUMERATED"):
     verified_action({"op":"click_relative","bid":graphic["ref"],"value":"1.01:0.20"},cs,[])
 def test_progress_allows_repeated_fresh_generation_action(self):
    cs=observed_mecord_candidates(obs([item()]))
    history=[{"op":"click","bid":"b-abc123-5-1","identity":cs[0]["identity"],"value":"","progress":True}]*2
    self.assertEqual(verified_action({"op":"click","bid":cs[0]["bid"]},cs,history)["op"],"click")
 def test_oversized_model_value_is_rejected_not_truncated(self):
    cs=observed_mecord_candidates(obs([item(role="textbox")]))
    with self.assertRaisesRegex(MecordObservationError,"ACTION_FIELDS_INVALID"):
     verified_action({"op":"type","bid":cs[0]["bid"],"value":"x"*401},cs,[])

 def test_observed_shape_colors_and_circle_geometry_reach_model(self):
    graphic=item(active=False,name="Target color")
    graphic["tag"]="circle"
    graphic["colors"]={"fill":"rgb(255, 0, 0)","stroke":"rgb(0, 0, 0)"}
    graphic["shape"]={"circle":{"cx":30,"cy":40,"r":12},"center":{"x":30,"y":40}}
    graphic["numericValue"]=7
    cs=observed_mecord_candidates(obs([], [graphic]))
    self.assertEqual(cs[0]["colors"]["fill"],"rgb(255, 0, 0)")
    self.assertEqual(cs[0]["shape"]["circle"]["r"],12)
    self.assertEqual(cs[0]["numericValue"],7)
if __name__=="__main__":unittest.main(verbosity=2)
