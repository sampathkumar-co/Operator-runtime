# Mecord Connect — Background-tab native input latency investigation

This is a standalone diagnosis and benchmark on the isolated `perf/background-tab-diagnosis-20261011` branch, based on tracing PR #306 (`1103e818373dd798e58f2692cc983a138d1274b8`). It is **not a released optimization** and makes no changes to the normal browser provider, hosted relay or installed runtime.

## Root cause observed in a local synthetic Chrome fixture

Original 30-iteration experiment on the Sampath laptop:
- Background tab, five-step workflow: p50 11,187.2 ms, p95 11,213.3 ms.
- Foreground tab, same scenario class: p50 1,156.3 ms, p95 1,195.0 ms.
- Background flag experiment, 10 five-step repetitions with `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, and `--disable-backgrounding-occluded-windows`: p50 11,191.6 ms, p95 11,205.2 ms. **No meaningful improvement.**
- In the latter run, 150 `Input.dispatchMouseEvent` calls accounted for 100,434 ms aggregate; p95 5,013.18 ms. `Runtime.evaluate` p95 was only 13.62 ms. This identifies the native mouse-event acknowledgement as the immediate bottleneck, not relay, target discovery, or script evaluation.
- A separate 10-repetition **focus-emulation diagnostic** used the CDP command `Emulation.setFocusEmulationEnabled` (true on the inactive synthetic target, then false during cleanup). p50 fell to **2,027.6 ms**, p95 **2,397.2 ms**. However, while emulation was enabled the page reported `document.visibilityState = "visible"` and `document.hasFocus() = true`. This **changes observable website semantics** and is *not an acceptable default for arbitrary user tabs*. A 30-repetition run and explicit restoration assertion are part of the follow-up acceptance.

Windows_NT 10.0.26200, Chrome 154.0.8037.98, Node 22.14.0. These are independently run local tests; effects cannot be attributed to hosted latency without a source-matched hosted run.

## Reproduce safely

Use only a separate repository worktree and Chrome's own temporary profile. The established `scripts/benchmark-pipeline-latency.mjs` runner provides a controlled localhost website, 30 navigation/SPA/tab-switch/cold/warm/failure samples and 30 five-step samples by default.

Windows PowerShell:

```powershell
$env:OPERATOR_PIPELINE_TRACE_ENABLED='1'
$env:MECORD_BENCH_SCENARIOS='extended'
$env:MECORD_BENCH_SKIP_WORKFLOW_FOCUS='1'
$env:MECORD_BENCH_DIAGNOSTIC_REPS='30'
node --experimental-strip-types scripts/benchmark-pipeline-latency.mjs
```

Diagnostic variants:
- `MECORD_BENCH_BACKGROUND_FLAGS=1`: isolated Chrome background-throttling flags.
- `MECORD_BENCH_FOCUS_EMULATION=1`: **synthetic-only** CDP focus/visibility emulation. The runner must prove the hidden/unfocused state is restored before finishing; its `finally` also disables emulation and closes the isolated CDP socket on failures.
- Neither mode changes the installed browser, the production runtime, user accounts, user data, approval state, or user-selected tabs.

## Safety and release decision

Do not automatically activate another tab, replace trusted mouse input with `element.click()`, disable authorization, reduce postcondition checks, or apply focus emulation to arbitrary existing user tabs. For any market release a separate browser ownership/consent design, a real non-synthetic website test matrix, cancellation/reconnect regression tests, and P0 security acceptance are necessary. This branch contributes exact root-cause evidence and a repeatable isolated diagnostic, not production acceptance.

The full hosted end-to-end certification remains dependent on an authorized release of the tracing branch and belongs to the installed-runtime workstream, not this local investigation.
