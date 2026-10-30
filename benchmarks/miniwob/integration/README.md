# MiniWoB × Mecord RC6: isolated, consented evaluation adapter

**Status: experimental benchmark tooling, not part of the product runtime or a release acceptance certificate.**

This adapter compares model-driven action selection with the exact `mecord-connect@2.0.7-rc.6` compiled `BrowserCdpProvider`. It reuses the source-only `../controller.py` for action normalization / replay safeguards and the new `../mecord_observation.py` to project **only actionable, generation-bound Mecord semantic/visual references**.

Unlike the older evaluation script, the model never supplies CSS selectors, pixel coordinates or raw BrowserGym `[bid]` targets to the execution bridge. Each step obtains a fresh `browser.inspect` from the actual RC6 provider, and the bridge independently verifies that its selected `ref` was present in the exact current observation. For observed SVG text/paths/circles/rectangles with geometry but no ordinary actionability, it additionally permits `click_relative` **only** at the bounded observed element centre (0.5, 0.5), subject to Mecord's native stale-ref and hit-test safeguards. The model cannot choose coordinates. A ref is invalidated before action dispatch, including when an outcome is uncertain. Multi-frame elements without exact observed frame authority are not used. The adapter does not patch installed BrowserGym packages: in-process Playwright launch configuration chooses the configured local Chrome for BrowserGym's task and chat browsers and only exposes the isolated task browser on a loopback debugging port.

## Installation and prerequisites

* Separate temporary benchmark workspace; **never** use the production browser profile, real store, original user data, live relay or historical receipts.
* Python 3.11; `browsergym-miniwob==0.14.3` (pins Playwright 1.44); installed Chrome; Node.js capable of executing the **isolated** RC6 compiled package.
* Pinned local source checkout `Farama-Foundation/miniwob-plusplus@7fd85d71a4b60325c6585396ec4f48377d049838` at `<workdir>/miniwob-plusplus`. Runner refuses a different commit or a roster other than 125.
* The RC6 `mecord-connect` package root isolated from globally installed npm. Bridge refuses an unexpected manifest version or source commit (`beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4`).
* The host must explicitly inject `MUSE_API_KEY` into the process environment. **Never commit or log this value.** No credential is read from a user home-directory template by repository code.

Required environment variables: `MECORD_MINIWOB_WORKDIR` (absolute temporary workspace), `MECORD_MINIWOB_RUNTIME_PATH` (absolute RC6 **package root**), `MECORD_MINIWOB_CHROME` (Chrome executable), `MUSE_API_KEY` (host-injected secret). The runner writes results only under `<workdir>/results`, and refuses to overwrite an existing result.

Run the **credential-free** integration smoke first; it verifies that the exact Mecord provider can click one currently observed button and the independent BrowserGym scorer returns reward 1.0. Set the three required non-secret path variables first. This scripted test **does not** measure autonomous model accuracy.

```shell
python benchmarks/miniwob/integration/smoke.py
```

Run a low-cost single-task pilot first:

```shell
python benchmarks/miniwob/integration/run_live.py --task-id browsergym/miniwob.click-test --limit 1 --seed 42 --max-steps 2 --cap-usd 0.005
```

The runner supports `--limit 125`, seeds, per-task step limits, and a per-run maximum cost of USD 0.070. **This is not a lifetime account spending cap.** The authorized operator must account for all previous runs and model/API usage separately. Do not start a second run just because the per-run budget is available. The underlying API reports token usage, which is converted to estimated cost at documented model rates. USD/INR conversion and billing may differ.

## Hardening and budget accounting

* Every local bridge request requires a randomly generated per-run bearer capability. Calls without it return HTTP 403. The bridge serializes requests, rejects extra model parameters, and invalidates the current ref before dispatch.
* The browser child process does not inherit the Meta API key. An observed Mecord ref must be supplied exactly; CSS/coordinate/name fallback cannot authorize a guessed target. Value-editing and selecting require compatible observed control roles, checked both by the pure controller and the bridge.
* By default the runner allows **USD 0.005** per run. It rejects a per-run cap above **USD 0.070** and persists a conservative **pre-call reservation ledger** with a workspace-wide lifetime ceiling of USD 0.070. It takes a short-lived exclusive lock around each ledger reservation, allowing authorized concurrent workers to share one ceiling without simultaneous overspending. A stale lock is fail-closed and must be inspected before removal. Model HTTP failures consume the reservation, rather than assuming a free retry.
* This ledger covers only calls from this **new** harness in the same workspace. It cannot prove actual provider billing or account-wide expenditure; prior model calls, any other tools and foreign-exchange variation must still be accounted for by the operator. It is deliberately conservative relative to the owner's overall ₹10 limit.
* If quota, spending or model usage accounting fails, the run stops and records a **partial campaign** and unscored episode, not invented zero-reward completions. Offline unit tests and no-model browser smoke run without Meta credentials.

## Scoring, safeguards, limitations

* Every task uses BrowserGym's independent `reward`, never the model's claim of success.
* The model gets a bounded JSON list of Mecord-observed controls and visual objects; it cannot invent selectors or receive arbitrary execution privileges.
* The source-only controller validates the requested action, current ref, values, repeat limits and uncertain-action history.
* The bridge allows only a **single** observed reference to a single matching local MiniWoB tab. It never exposes the public relay or production user profile.
* Up to one additional model correction is allowed for invalid/truncated JSON **before** any browser action. A truncation-only retry uses a larger 3,072-output-token allowance, charged against the same conservative cost reserve. Browser interaction failures are reported, not blindly replayed.
* The browser scorer can return zero on graphical puzzles for which the bounded observer yields no actionable ref. A missing ref is a limitation, not permission to fabricate coordinates.
* Raw success rates must report the **full roster including failures**, per-seed results, model, source SHA, runner digest, budget, and separate categories of model, controller, provider, and environment errors. Model-only, scripted and model-driven tasks must not be merged into one score.
* No npm publish, VPS changes, production approvals, or product runtime changes are part of this harness.

Unit tests (no API key/network/browser):

```shell
python -m unittest discover -s benchmarks/miniwob -p 'test_*.py' -v
```

The current MiniWoB evaluation remains **partial** until a complete independent 125-task campaign with authenticated scores and the separate release gates passes.
## Frozen 50-task development gate (29 October 2026)

The first development attempt used a deterministic evenly spaced 50-task roster
from 125 registered BrowserGym tasks, seed 42, contributor model, explicit
`reasoning_effort=low`, initial `max_tokens=2048`, truncation-only retry
`max_tokens=3072`, six steps per task, and real Mecord RC6 actions.

**Paused after seven episodes:** two independently verified reward-1.0 successes;
four ordinary failed/unfinished episodes and one Meta SSL/TLS handshake timeout
which must **not** be interpreted as a model action mistake. The runner was
stopped and its raw results retained; it did not complete the remaining 43
episodes or establish a 70% success rate. Raw evidence is in the owner's
isolated workspace
`results/meta_rc6_grounded_portable_50_seed42_worker0of4.jsonl`.
The old run reserved USD 0.0104692 of conservative output-token budget in
`results/mecord-api-reservations.jsonl`. Model-usage receipts for the
completed sixteeen calls reported USD 0.002683, with one additional
pre-reservation for an interrupted call. Provider billing may differ.

A source audit of the failures found **previously unused Mecord capabilities**:
native observed-target scrolling on a listbox and `drag_between` of
observed sortable-list elements. Both were implemented as generic strictly
bounded actions, not task-name conditionals. The pure adapter suite is
**35/35 PASS**; **real no-model Mecord provider probes** on
`click-scroll-list` and `drag-items-grid` returned `browser.cdp`
`ok:true` without scoring the whole tasks. This is engineering evidence,
**not** a new AI-model benchmark score.

The next frozen run has checkpoint options `--limit 50 --workers 1 --start-at
0 --count 10 --campaign-tag v6`, preserving the full 50-task roster hash and
using a separate result filename. That paid checkpoint was **not executed**
because the remote action was blocked by the execution host's safety checks;
no new process or result was created. It must not be reported as completed.

Proceed only with budget authorization and genuine execution permission.
Measure each checkpoint's independently scored successes and separately report
model/transport/bridge/grounding failures. If the score is below 70% at a
checkpoint, pause and diagnose rather than quietly switching task selections.
The full 50-task threshold is 35 successful episodes; stopping early does
not entitle the project to claim the benchmark passed.



## 30 October 2026 adapter audit and checkpoint-integrity repair

The updated adapter on the authorized laptop was reviewed against the pinned RC6 provider, then committed to this draft PR. Its observed controls now cover bounded scroll, sortable drag, date entry, candidate visual geometry, optional synthetic-only CDP screenshot capture, local bridge authorization, fresh-reference execution, and independently verified BrowserGym rewards. Native double-click/Shift-click/drawing extensions are in separate **unmerged** PR #696, **not in RC6**; this adapter must not presume otherwise.

The source now contains `budget_ledger.py` for locked, fsynced pre-call token-cost reservations shared between workers; `model_failures.py` and `bridge_protocol.py` for fail-closed diagnostics; `bridge_actions.mjs` and `browser_visual.mjs` for bounded native actions and screenshot validation; and `aggregate_campaign.py` for read-only scoring. Model keys are injected only into the runner, not the CDP bridge.

**Additional audit repair:** every new episode records `harness_sha256`, a fingerprint of the runner, Mecord projection, source controller and bridge helper files, along with the MiniWoB source SHA. The checkpoint aggregator accepts multiple disjoint files for the same worker, but independently reconstructs the canonical 50-of-125 roster and rejects wrong task IDs, duplicate indexes, mixed seed/step/vision settings, changed harness implementations, invalid rewards or missing task coverage. **Only a complete, independently scored frozen 50-task campaign can be declared PASS at 35/50 successes.**

No-cost laptop checks after the repair: **56/56 controller Python tests**, **6/6 checkpoint-aggregator Python tests**, **10/10 bridge-action JS tests**, **3/3 visual JS tests**, Python/JS syntax checks, and the regular and screenshot-enabled browser smoke tests (each exact RC6 `browser.cdp` and independent reward 1.0). These tests do not measure Meta success rate.

The planned development checkpoint uses `--limit 50 --workers 1 --worker 0 --start-at 0 --count 5 --campaign-tag oct30r1 --seed 42 --max-steps 6 --cap-usd 0.012`, with the same Meta Muse Contributor model, `reasoning_effort=low`, 2,048 initial output tokens, a single truncation-only 3,072-token retry, and **vision disabled** for comparability with the earlier run. The attempt to start this paid checkpoint was blocked by the execution host's safety controls; its result file does not exist and **no model call was made**. Do not bypass this block. The original, older-adapter 2/7 development result remains separate and unchanged.

For later independent reporting, run `aggregate_campaign.py` over the exact checkpoint files using `--expected 50 --seed 42 --workers 1 --harness-sha256` from the newly recorded episode metadata. It returns `PARTIAL` and `NOT_EVALUATED` until all 50 canonical tasks are present and scored; do not mix checkpoints from different adapter fingerprints. Preserve the existing append-only budget ledger and account for historical model charges separately.
