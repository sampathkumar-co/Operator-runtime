# MiniWoB adapter installed on LAPTOP-MRNU23B2 (30 October 2026)

This folder contains a **synthetic browser benchmark adapter**, not Mecord's
production TaskOrchestrator. Do not install it into the global npm package.

## Physical workspace
- Existing workspace: `%TEMP%\mecord-rc6-qualification-beef93d3`.
- Adapter: `integration\mecord_bridge.mjs`, `integration\run_live.py` and helper modules.
- Original adapter backup: `integration-backup-20261030-1418` inside the same workspace.
- Mecord runtime: `isolated-install\node_modules\mecord-connect`, exactly **2.0.7-rc.6**
  at source `beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4`.
- MiniWoB fixtures: pinned `miniwob-plusplus` checkout at `7fd85d71...`.
- Python: the pre-existing `bg-meta-venv311\Scripts\python.exe`, not system Python.
- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Credential-free validation
From PowerShell in this integration folder:

```powershell
.\smoke-local.ps1
```

This tests authenticated bridge inspection/dispatch, real Chrome
screenshot capture from the exact synthetic fixture tab, replay refusal,
and independent BrowserGym click-test reward. No Meta requests are made;
the wrapper removes `MUSE_API_KEY` from this child process environment.

Additional local provider probes in the established workspace:
`provider-actions-smoke.py` (scroll, drag) verify execution only,
not successful MiniWoB rewards.

## Correctness and remaining gates
- The controller now preserves verified pre-dispatch/no-side-effect bridge
  failures to allow a **new** observation and decision; uncertain execution
  remains nonreplayable.
- Meta HTTP 400/401/403/408/422/429 and 5xx are recorded as campaign-stopping
  *unscored* provider errors; only sanitized error code/type is retained.
- Browser provider exposes both `semantic.visibleText` and `semantic.textExcerpt`.
  The adapter accepts either, with a bounded fallback.
- Vision capture is real, but Meta multimodal compatibility and cost have **not**
  been verified with live model calls.
- Native double-click, Shift-click and multi-point drag-path are in
  **unmerged PR #696**, not in the pinned RC6 runtime. Do not claim them
  available here until a separately approved runtime build and physical test.
- The original 2/7 campaign was from older code; **do not relabel it as a new score**.
- Do not overwrite original JSONL results or the append-only spend ledger.

## Native graphical source-mode validation (October 30)

Native graphical source is staged **only** in PR #696 at commit
`7e73340fa8478810b9a14ee5d6943caf9dbea6ed`.
The installed `2.0.7-rc.6` package is deliberately unchanged.

From the existing isolated workspace's `integration` folder:

```powershell
.\smoke-native-local.ps1
```

The native opt-in wrapper verifies the exact source commit and RC6 package,
removes the model API credential from its process, and exercises:
(1) double-click through Mecord with BrowserGym reward,
(2) Shift-click through Mecord with BrowserGym reward,
(3) bounded held-button drawing through the Mecord provider against a
temporary synthetic Chrome test page. All three passed on LAPTOP-MRNU23B2.
The regular `smoke-local.ps1` still uses pinned RC6.

The model runner has an explicit `--native-gestures` flag, which is refused
unless `MECORD_MINIWOB_NATIVE_SOURCE_ROOT` points to this exact
source checkout. No paid model campaign has run in this mode; the
model-provider response schema and full independent MiniWoB score remain
unqualified. Source mode cannot be presented as a published npm release.
