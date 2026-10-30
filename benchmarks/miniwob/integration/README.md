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
* By default the runner allows **USD 0.005** per run. It rejects a per-run cap above **USD 0.070** and persists a conservative **pre-call reservation ledger** with a workspace-wide lifetime ceiling of USD 0.070. It takes an exclusive lock to prevent concurrent model spending. If interrupted, a stale lock is fail-closed and requires inspection before removal. Model HTTP failures consume the reservation, rather than assuming a free retry.
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


## Deep-audit corrective branch (29 October 2026)

Fixes under stacked draft PR #695 are **benchmark-only** and not the
shipping TaskOrchestrator. Do not interpret the source test score as an AI
benchmark performance improvement or a production release acceptance.

- The provider's `set_value` means slider updates, whereas its `type`
  operation replaces textbox contents. The bridge now translates non-slider
  `set_value` into `type` while preserving genuine slider actions.
- Each fresh observation may regenerate a `bid`. Replay detection also uses
  a bounded stable observation fingerprint, with the provider still retaining
  its authoritative side-effect/no-progress controls.
- Model observations now include bounded headings, text excerpt, checked and
  selected states, input values, placeholder, and a real page-scroller ref.
  The first tranche reserves room for visual candidates. Candidate JSON is
  composed from whole records rather than cut mid-element.
- Wait, keyboard text, bounded directional drag/resize, hotkey, text formatting
  and selection-range operations now have a restrictive benchmark adapter
  vocabulary. New operations must be accepted by the actual runtime provider;
  offline tests cannot certify live DOM behavior.
- Every episode retains sanitized step-level evidence, the controller sees
  whether an interaction progressed, and an explicitly no-effect pre-dispatch
  refusal may trigger a fresh decision. Uncertain post-dispatch operations
  remain **non-replayable**.
- Local bridge transport errors are distinguished from Meta transport errors.
  The CDP bridge process receives an explicit environment allowlist.
- The runner defaults to six steps per task. Workers 0–3 can reserve
  from a common durable O_EXCL, short-lived locking ledger in one isolated
  workspace. A lock is never held across a model/browser call, and failures
  do not steal an uncertain owner's lock. The global campaign digest is
  recorded before worker partitioning. Actual provider billing remains
  authoritative; input-image charges are conservatively reserved, not a
  provider-certified upper bound.
- Keep `--limit 50 --workers 1 --worker 0 --max-steps 6 --seed 42`
  explicitly pinned for future development runs. This is not a like-for-like
  reproduction of the older four-worker checkpoint; compare fixed **task IDs**
  and manifests, not only the aggregate scores.
- New CI checks Python syntax, Node bridge syntax and pure controller/bridge
  fixtures without Meta credentials or browser execution.

### Still not covered by this isolated source patch

The **code paths** for transient CDP screenshots, opt-in Meta vision
requests, bounded iframe observations with explicit allowed origins, enumerated
hit-tested graphical positions and a shared four-worker budget ledger now
exist. They are source-tested, NOT physically qualified. Additional graphical
types, cross-origin navigation beyond explicit owner-authorized origins,
stable multimodal latency/cost measurements, source-pinned 50/125 model-driven
qualifications, physical device acceptance and production TaskOrchestrator
integration remain unverified or unimplemented. No benchmark success is
claimed for them.

The benchmark runner's separate entry point expects explicit host-injected
`MUSE_API_KEY`. The production signed benchmark wrapper intentionally
filters ambient environment variables, including credentials; **do not
weaken that boundary to make this harness work automatically**. A separately
reviewed credential broker would be needed for approved integrated launch.

### Multimodal and multiworker source-only usage

`--vision` adds one transient, bounded JPEG screenshot captured using the
exact fixture tab's Mecord CDP session. The screenshot is returned to the
isolated Meta runner as a user-image content part; only its SHA-256 and
byte count appear in the trace. Raw images are not persisted. If CDP
capture fails or the task tab navigates out of the fixture, a vision run
fails closed. Visual tokens consume the same workspace spending cap.

An OOPIF URL is accepted only when it resides under the pinned file fixture
root or its canonical HTTP(S) origin is listed in the independently configured
`MECORD_MINIWOB_FRAME_ORIGINS` comma-separated allowlist. Same-origin frame
refs must carry observed nested-frame provenance. Unlisted third-party
frame content is excluded, not silently treated as authorized.

Worker example, using the **same workspace**, task selection and seed:

```shell
python benchmarks/miniwob/integration/run_live.py --limit 50 --workers 4 --worker 0 --count 1 --seed 42 --max-steps 6 --vision --cap-usd 0.01
```

This example requests just **one** vision checkpoint task, not a complete 50-task
campaign. The runner checks conservative budget feasibility before launching
the paid bridge; one screenshot per task reserves at least $0.0036864 at the
configured rates before prompt text and retries. Under the immutable
USD 0.07 workspace ceiling, a 20/50-task vision campaign is infeasible and
is explicitly rejected before API use. Worker indices 1, 2 and 3 use
corresponding `--worker` arguments and disjoint `--start-at` / `--count`
slices under the same ledger. A smaller checkpoint is not a benchmark score
and neither source tests nor partial results prove 70% accuracy.

Only **after all four worker files exist**, report the frozen manifest result
with the report-only command:

```shell
python benchmarks/miniwob/integration/aggregate_campaign.py --expected 50 --seed 42 --workers 4 --harness-sha256 <EXACT_64_CHAR_HARNESS_DIGEST_FROM_RUN> --runtime-manifest-sha256 <EXACT_64_CHAR_RUNTIME_MANIFEST_DIGEST_FROM_RUN> <checkpoint0.jsonl> <checkpoint1.jsonl> ...
```

The aggregator accepts multiple disjoint checkpoint files, verifies exact frozen
task IDs and SHA-256 harness identity from each run, and denies mismatched
model/vision/step-limit conditions, duplicate tasks and unscored pass claims.
The required `--harness-sha256` must come from actual runner evidence; do
not invent it to satisfy the CLI. It cannot infer
independent task rewards when no real BrowserGym run has been executed.

Production integration must use the production kernel's authority/policy
and verified task planning contracts, not invoke this raw benchmark bridge
against personal Chrome tabs. That integration remains a separate approval
and qualification gate.

## Native gesture source integration and observation paging (30 October 2026)

PR #699 combines the isolated benchmark controller source with PR #698's
native double-click, Shift-click, held-pointer drawing and recovery logic.
**This is source integration only.** The currently installed
`mecord-connect@2.0.7-rc.6` remains pinned and returns
`nativeGesturesEnabled=false`; it cannot execute the new operations.

A separately built, independently verified and owner-authorized candidate
with a non-legacy source revision is required. For that candidate, the operator
must supply `MECORD_MINIWOB_NATIVE_GESTURES=1`,
`MECORD_MINIWOB_EXPECTED_RUNTIME_VERSION`,
`MECORD_MINIWOB_EXPECTED_RUNTIME_COMMIT` and
`MECORD_MINIWOB_EXPECTED_MANIFEST_SHA256` (the SHA-256 of the exact compiled
`runtime/runtime-manifest.json` bytes). The bridge verifies all four and fails
closed if the installed runtime differs. The model cannot unlock this contract.

When that pin succeeds, the model may choose:
`double_click` or `shift_click` on a fresh actionable observed ref,
or `drag_path` on a fresh observed graphical ref. The drawing `value` is
two to 24 semicolon-separated two-decimal relative points inside that
observed element, for example `0.10:0.10;0.90:0.90`. Every point remains
subject to native provider hit-tests; there is no unrestricted screen click.
Mecord dispatch success still does not imply independent BrowserGym reward.

The model may choose `inspect_next_page` with empty ref/value/key if
the actual Mecord inspection reports a further control/visual page.
The runner requests only provider-returned offsets and discards old refs
on every inspection. Pagination is bounded at offset 640 and six steps
per default episode. It **does not** claim unlimited graphical coverage
or continuous moving-target tracking. No extra model budget is granted.

Every episode now records the exact compiled runtime manifest digest in
addition to the frozen harness source digest. The scorer rejects checkpoints
from different compiled runtimes, even if their task IDs and prompts match.

**Release and measurement HOLD:** no native gestures have been physically
tested on the offline owner's laptop, no signed next runtime candidate exists,
no 20/50/125 model-driven run has been completed on this combined source,
and there is no evidence of 70% MiniWoB accuracy.
