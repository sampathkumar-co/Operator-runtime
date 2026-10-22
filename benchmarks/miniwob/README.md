# Mecord Connect — generic model-driven MiniWoB evaluation

This folder restores a **maintainable benchmark-controller integration**, not the lost original untracked GPT-OSS runner. It uses the real native Mecord `BrowserCdpProvider` from a selected source checkout, with Meta Muse Spark 1.3 Contributor as the model, BrowserGym MiniWoB as independent scorer, and Chrome restricted to a disposable local test page.

## Components
- `controller.py`: model-agnostic observation normalization, accessibility and generic DOM/SVG grounding, bounded action validation, no-progress and uncertain-write stop handling
- `bridge.mjs`: loopback-only Node bridge to native Mecord browser.cdp. Restricts navigation to the configured local MiniWoB file URL, action types, and candidate selector syntax; does not connect to production relay
- `run.py`: model calls, per-episode fixed budgets, no overwriting previous results, JSONL evidence, independent BrowserGym scoring
- `audit.py`: checks exact task count, disjoint workers, unique IDs, seed, SHA-256 logs and total cost
- `patch_browsergym_cdp.py`: reversible explicit loopback CDP instrumentation, **only** in the dedicated browsergym-venv
- `test_controller.py`, `test_dom_v2.py`: generic policy and candidate-grounding unit tests

## Source and acceptance
- Mecord target source initially RC3 commit `a13cb0d1aefaee6da33c6a7d65866773f8f36b5d`.
- Historical source can be selected by setting `MECORD_PROVIDER_ROOT` to the separate verified detached worktree at commit `7c9b0777b252186cdef21525990f87525c0040dd`.
- MiniWoB++ asset commit `7fd85d71a4b60325c6585396ec4f48377d049838`, BrowserGym MiniWoB `0.14.3`.
- This controller is intentionally **not** benchmark-task-specific. No task names, answers or environment reward internals enter model prompts.
- Failed tasks and absent model responses count in denominators, not filtered.
- Cost estimates use the verified input/output pricing from the test session; API invoice may vary.
- The `MUSE_API_KEY` is read locally from `%USERPROFILE%\Documents\Mecord_API_Keys_Template.txt`, never placed in command-line args, printed, committed or included in reports. Migrate plaintext storage to an encrypted credential store before distributing.
- Research-only: Contributor mode may allow model provider training on prompts. Run only synthetic public tasks.

## Environment (Windows PowerShell)
Use an isolated Python 3.12 venv and the pinned MiniWoB package, *not* the original production state. Set the benchmark directory and the isolated provider source root:

```powershell
$env:MECORD_MINIWOB_ENV_DIR = "$env:LOCALAPPDATA\Temp\mecord-yc-benchmark-20261022"
$env:MECORD_PROVIDER_ROOT = "C:\Users\SAMPATH\OneDrive\Desktop\Mecord-Historic-Production-Restore-20261022"
$py = "$env:MECORD_MINIWOB_ENV_DIR\browsergym-venv\Scripts\python.exe"
& $py -m pip show browsergym-miniwob
& $py patch_browsergym_cdp.py
& $py -m unittest test_controller test_dom_v2 -v
& $py run.py --limit 12 --seed 42 --max-steps 8 --cap-usd 0.05 --worker 0 --workers 1
& $py audit.py --limit 12 --seed 42 --workers 1
```

To run all 125 tasks, launch four separate workers (`--limit 125 --workers 4 --worker 0`, then 1, 2, 3), each in its own process; use unique CDP ports 9360–9363. After all workers exit successfully run `audit.py --limit 125 --seed 42 --workers 4`. Freeze model/provider versions, source hashes, and action limits before comparing scores.

## Security and release limits
This is a **benchmark-only** adapter. Its loopback test bridge is not a supported public plugin entry point or a replacement for Mecord's AgentKernel authorization, approvals, side-effect journal, recovery fences, signed receipts, or desktop runtime. Do **not** run against production remote relay or `C:\Users\SAMPATH\.operator`; no replay/ACK or restart is authorized by benchmark success. Old claimed 94/125 or 102/125 results are historical, not reproduced by this adapter.

## Known limitations
- Limited actions: click, hover, set value, type, select, key press, explicit wait; drag-and-drop, scrolling, canvas gestures, and rich multi-app observations need provider-authorized generic implementation and independent tests.
- Some MiniWoB graphics need multimodal reasoning; the text-only Meta model can still fail with DOM grounding.
- Model success and Mecord provider reliability are different metrics. Compare matched model and controller across providers before asserting a product regression or improvement.
