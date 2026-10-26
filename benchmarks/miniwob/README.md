# Isolated MiniWoB observed-action controller

This folder contains **only** the side-effect-free, model-agnostic controller extracted and hardened from legacy [PR #359](https://github.com/sampathkumar-co/Operator-runtime/pull/359). The original PR included a runner reading a home-directory credential template, an external model API adapter, an installed BrowserGym environment patcher, a loopback action bridge and historical evaluation results. **None of those executable surfaces or old scores is imported by this extraction.**

## Implemented, source-only

- Normalize bounded accessibility and DOM/SVG snapshots into observed candidates with stable IDs and scoped, derived selectors. Model output cannot invent an element ID or a CSS selector.
- Accept only an allowlisted bounded action contract; reject model-provided objects, nonliteral values, unknown actions, unobserved targets and ambiguous accessible names.
- Stop retrying after uncertain/reconciliation-required results, rather than automatically dispatching model suggestions after uncertain effects.
- Generate a bounded synthetic prompt and interpret actions only. **No network calls, credentials, filesystem mutation, Chromium launch, API registration, remote relay, npm changes or autonomous approval** exist in the controller.
- Run `python3 -m unittest discover -s benchmarks/miniwob -p 'test_*.py' -v`. The dedicated CI workflow checks that the controller imports only standard-library pure modules and contains no direct execution/file API calls.

## Truth and limitations

This is a *source-contracted candidate*, not a completed benchmark controller, browser action runtime, or proof of benchmark success. MiniWoB evaluation still requires a separately authorized disposable environment, a model budget/consent policy, exact BrowserGym scorer/version, source-matched Mecord provider and independent held-out runs.

No model API key is read or sent. Do not treat model suggestions as direct production authority or infer any improvement to the earlier MiniWoB score from these unit tests. We intentionally leave out the legacy runner, BrowserGym site-packages patcher, native bridge, original host paths, historical model prices and scores. Integrate a new source-pinned, consented, bounded evaluation adapter only after the C01 runner and scorer contract is independently accepted.
