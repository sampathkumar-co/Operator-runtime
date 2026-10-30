import unittest
from integration.inspection_paging import next_page_offsets
from mecord_observation import verified_action, MecordObservationError

def pages(control_next=160, visual_next=160):
    return {"controls":{"offset":0,"returned":160,"total":500,"truncated":control_next is not None,
        **({"nextOffset":control_next} if control_next is not None else {})},
        "visualObjects":{"offset":0,"returned":160,"total":500,"truncated":visual_next is not None,
        **({"nextOffset":visual_next} if visual_next is not None else {})}}

class PagingTests(unittest.TestCase):
    def test_uses_only_provider_reported_offsets(self):
        self.assertEqual(next_page_offsets(pages()),{"controlOffset":160,"visualOffset":160})
        self.assertEqual(next_page_offsets(pages(None,160)),{"controlOffset":0,"visualOffset":160})
        self.assertIsNone(next_page_offsets(pages(None,None)))

    def test_offsets_must_advance_and_stay_bounded(self):
        for value in (-1,0,641,True,1.4,"next",None):
            if value is None: continue
            self.assertIsNone(next_page_offsets(pages(value,160)))
        self.assertIsNone(next_page_offsets(pages(160,160),
            current_control=160,current_visual=160))
        self.assertIsNone(next_page_offsets({},current_control=0,current_visual=0))

    def test_page_change_never_grants_action_authority(self):
        self.assertEqual(verified_action({"op":"inspect_next_page","bid":"",
            "value":"","key":""},[],[]),{"op":"inspect_next_page"})
        for bad in ({"op":"inspect_next_page","bid":"b-abc123-7-1"},
                    {"op":"inspect_next_page","value":"100"}):
            with self.assertRaisesRegex(MecordObservationError,"PAGE_CHANGE_MUST_HAVE_NO_TARGET"):
                verified_action(bad,[],[])
        with self.assertRaisesRegex(MecordObservationError,"UNCERTAIN_HISTORY"):
            verified_action({"op":"inspect_next_page"},[],
                [{"sideEffectState":"uncertain"}])

if __name__=="__main__":
    unittest.main()
