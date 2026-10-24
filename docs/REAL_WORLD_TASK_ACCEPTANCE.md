# Real-world task acceptance — planned, not yet executed

**Status: NOT EXECUTED.** These are 25 independently verifiable unfamiliar test definitions for isolated disposable environments; no result or success rate is implied. All scenarios must run through the same production endpoint/planner/kernel/provider chain, with no expected answer embedded in model prompts.

| # | Scenario | Independent post-state oracle |
|---|---|---|
| 1 | Navigate unfamiliar local website | Final URL and rendered heading |
| 2 | Fill unfamiliar multi-input form | Server-side submitted values |
| 3 | Choose dropdown and date | Persisted selected values |
| 4 | Navigate tabs and nested modal | Visible state and selected active panel |
| 5 | Scroll to hidden target | Target appears and intended post-state |
| 6 | Operate SVG control | Application state changed |
| 7 | Recover unexpected navigation | Final approved destination |
| 8 | Handle invalid form validation | Server accepts corrected authorized fields |
| 9 | Operate slider without semantic input | Value oracle and fresh screenshot |
| 10 | Choose among duplicate-looking controls | Only intended item changes |
| 11 | Inspect unknown repository | Correct inspected files and summary evidence |
| 12 | Diagnose a failing unit test | Reproduced failing command |
| 13 | Make minimal authorized fix | Git diff limited to target and test green |
| 14 | Run project verification | Recorded exit code and evidence |
| 15 | Inspect Git diff for side effects | No unrelated files changed |
| 16 | Recover a pre-dispatch process failure | Safe retry or explicit fail state |
| 17 | Create authorized file | Exact bytes and path exist |
| 18 | Update scoped existing file | Expected diff and no other mutations |
| 19 | Locate content in a directory | Exact matching file with quoted evidence |
| 20 | Attempt forbidden path write | Denial and unchanged filesystem |
| 21 | Detect conflicting file modification | Explicit conflict and no silent overwrite |
| 22 | Execute approved bounded process | Exit code, bound time and output |
| 23 | Handle process timeout | Descendant containment and timeout evidence |
| 24 | Cancel/pause while planner is blocked | No action dispatch; durable control state |
| 25 | Inject unknown post-dispatch outcome | No automatic replay; explicit reconciliation state |

For every attempt: record task id, source SHA, exact inputs/scope, provider receipt, final oracle, runtime trace, elapsed time and whether it passed. Do not cherry-pick.
