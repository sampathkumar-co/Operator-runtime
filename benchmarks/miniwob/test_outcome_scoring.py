import unittest
from integration.outcome_scoring import score_terminal_if_unstepped

class FakeEnv:
    def __init__(self,reward=0):
        self.reward=reward
        self.calls=0
    def step(self,action):
        assert action=="noop()"
        self.calls+=1
        return {},self.reward,False,False,{}

class OutcomeTests(unittest.TestCase):
    def test_no_browser_step_always_uses_independent_scorer(self):
        env=FakeEnv(0)
        row={"reward":0,"steps":0,"trace":[]}
        self.assertTrue(score_terminal_if_unstepped(row,env))
        self.assertEqual((row["reward"],row["steps"],env.calls),(0.0,1,1))
        self.assertEqual(row["trace"][-1]["terminal_noop_reward"],0.0)
    def test_preserves_real_terminal_success(self):
        env=FakeEnv(1)
        row={"reward":0,"steps":0,"trace":[]}
        score_terminal_if_unstepped(row,env)
        self.assertEqual(row["reward"],1.0)
    def test_never_scores_failed_or_already_scored_episode(self):
        for row in ({"unscored":True,"reward":None,"steps":0},
                    {"reward":0,"steps":1}):
            env=FakeEnv()
            self.assertFalse(score_terminal_if_unstepped(row,env))
            self.assertEqual(env.calls,0)
    def test_invalid_reward_not_accepted(self):
        for reward in (float('nan'),float('inf'),True,-1,2,0.25):
            with self.assertRaisesRegex(ValueError,"BROWSERGYM_REWARD_INVALID"):
                score_terminal_if_unstepped({"reward":0,"steps":0},FakeEnv(reward))
if __name__=="__main__":
    unittest.main()
