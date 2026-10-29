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

Run a low-cost single-task pilot first:

```shell
python benchmarks/miniwob/integration/run_live.py --task-id browsergym/miniwob.click-test --limit 1 --seed 42 --max-steps 2 --cap-usd 0.005
```

The runner supports `--limit 125`, seeds, per-task step limits, and a per-run maximum cost of USD 0.075. **This is not a lifetime account spending cap.** The authorized operator must account for all previous runs and model/API usage separately. Do not start a second run just because the per-run budget is available. The underlying API reports token usage, which is converted to estimated cost at documented model rates. USD/INR conversion and billing may differ.

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