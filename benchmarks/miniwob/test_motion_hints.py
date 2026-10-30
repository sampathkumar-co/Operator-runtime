import unittest
from integration.motion_hints import motion_hints
def item(ref,x=0,y=0,name="Moving",frame=""):
 return {"bid":ref,"name":name,"role":"button","description":"semantic",
         "frameTargetId":frame,"geometry":{"x":x,"y":y}}
class MotionTests(unittest.TestCase):
 def test_moving_target_is_only_advisory(self):
  out=motion_hints([item("old",1,2)],[item("new",19,9)])
  self.assertEqual(out,[{"bid":"new","moved_x":18,"moved_y":7,"advisory_only":True}])
 def test_ambiguous_or_cross_frame_never_matches(self):
  self.assertEqual(motion_hints([item("a"),item("b")],[item("c",25)]),[])
  self.assertEqual(motion_hints([item("a",frame="first")],[item("b",25,frame="other")]),[])
 def test_no_predicted_clicks_or_targets(self):
  self.assertEqual(motion_hints([item("a")],[item("b",1)]),[])
  self.assertEqual(motion_hints(None,[]),[])
if __name__=="__main__":unittest.main()
