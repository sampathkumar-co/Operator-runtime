# Sampath laptop — real browser workflow benchmark (2026-10-11)

**Machine:** `LAPTOP-MRNU23B2` (Sampath, Windows 11), node v22.14.0. Global npm installation on the machine was observed at `mecord-connect@2.0.5`. The hosted Mecord developer connector successfully routed to this machine. This does **not** prove its source matches integration PR #295.

## A. Hosted Mecord browser workflow — 1/1 PASS

On Sampath's managed Chromium target `91E2909693E56CD5A81BD6C4154C6EB1`, executed a **single** real end-to-end user workflow through Mecord developer MCP browser actions, against a disposable HTTP fixture bound only to `127.0.0.1`. No actual account, money or external website was affected.

1. Navigate to customer intake; inspect actual semantic controls.
2. Enter customer name and synthetic `@example.test` email, select Business, check synthetic consent, submit; browser navigated to catalog.
3. Search for Blue Widget, submit server-backed filter, add item to cart, navigate to checkout.
4. Select Express, enter `TEST10`, submit server-backed synthetic checkout; browser navigated to receipt.
5. Inspect receipt: **Synthetic order verified**.
6. Independently read fixture's server-written `hosted-mecord-evidence.json`: `intake`, `cart=["blue-widget"]`, `checkout={"shipping":"express","promo":"TEST10"}`; events `intake → cart → checkout` in order.

All 12 `browser.interact` calls returned `VERIFIED` with no approvals bypassed. Includes navigation and browser inspections. Action provider time: p50 **371 ms**, p95 **397 ms** (n=12). Observed tool-call round-trip wall time: p50 **4,055 ms**, p95 **5,239 ms** (n=12); 47,469 ms accumulated across 12 interactions. These wall numbers include connector overhead and are **not** isolated browser execution latency. Not a statistically valid Mecord task success rate.

## B. Local actual-Chrome Playwright workflows — 20/20 PASS

Ran `playwright-workflow-benchmark.mjs` from an isolated folder on Sampath's laptop, using installed Chrome and Playwright. Each of **20 independently started local fixture backends** completed customer intake, filtered a product, added the item, reviewed checkout, submitted it, checked receipt and independently verified three server-side events plus the exact final state. Rotated Blue/Red/Green products, Retail/Business segments, and Standard/Express shipping. Tested desktop/mobile viewport widths. No mocks for browser DOM or HTTP backend.

- **Pass:** 20/20; **fail:** 0; sample success: 100% on this synthetic suite.
- End-to-end *local Playwright* workflow times: **p50 491.74 ms**, **p95 558.16 ms**, average 519.47 ms; first-run max 958.74 ms.
- Evidence: `playwright-workflow-report.json`, `workflow-desktop-receipt.png`, `workflow-trace.zip`; local artifact folder `C:\Users\SAMPATH\OneDrive\Desktop\Mecord-P0-Release-20261011\artifacts\real-browser-workflow-20261011`.
- Repro: `node playwright-workflow-benchmark.mjs` in that folder. It launches isolated Chrome contexts and disposable loopback fixture server processes and produces a fresh JSON report.

## Limitations / release status

- Do **not** treat Playwright's 20/20 as an autonomous Mecord browser-task score, nor extrapolate the one hosted Mecord trial to 100%.
- Prior separate 83/83 Playwright E2E evidence (different suite) is **not automatically** 83% BrowserGym/MiniWoB success.
- Not yet verified: 30+ **hosted Mecord** end-to-end workflow samples, representative held-out BrowserGym/WebArena task mix, p95/p99 across relay and planning, negative/approval-parity cases, sustained faults, and final signed binary/source identity. Keep benchmark/release gates open.
