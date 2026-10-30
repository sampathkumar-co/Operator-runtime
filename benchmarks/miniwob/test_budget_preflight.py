"""Pure, no-model vision campaign feasibility regression checks."""
import unittest
from integration.budget_ledger import require_budget_feasibility, BudgetError

class VisionBudgetPreflightTests(unittest.TestCase):
    def test_one_vision_task_fits_existing_small_run_cap(self):
        require_budget_feasibility(task_count=1, vision=True, run_cap=.005,
                                   lifetime_cap=.07, already_reserved=0)

    def test_twenty_vision_tasks_cannot_fall_into_partial_paid_campaign(self):
        with self.assertRaisesRegex(BudgetError, "VISION_RESERVATION_INFEASIBLE"):
            require_budget_feasibility(task_count=20, vision=True, run_cap=.07,
                                       lifetime_cap=.07, already_reserved=0)

    def test_fifty_vision_tasks_fails_even_with_zero_historical_use(self):
        with self.assertRaisesRegex(BudgetError, "VISION_RESERVATION_INFEASIBLE"):
            require_budget_feasibility(task_count=50, vision=True, run_cap=.07,
                                       lifetime_cap=.07, already_reserved=0)

    def test_lifetime_reservations_are_not_ignored(self):
        with self.assertRaisesRegex(BudgetError, "VISION_RESERVATION_INFEASIBLE"):
            require_budget_feasibility(task_count=1, vision=True, run_cap=.005,
                                       lifetime_cap=.07, already_reserved=.068)

    def test_nonvision_still_uses_atomic_call_by_call_ledger(self):
        require_budget_feasibility(task_count=50, vision=False, run_cap=.005,
                                   lifetime_cap=.07, already_reserved=0)

    def test_invalid_configuration_denied(self):
        for n in (0, -1, 1.5, True):
            with self.assertRaisesRegex(BudgetError, "BUDGET_PREFLIGHT_INVALID"):
                require_budget_feasibility(task_count=n, vision=True,
                                           run_cap=.07, lifetime_cap=.07,
                                           already_reserved=0)

if __name__ == "__main__":
    unittest.main()
