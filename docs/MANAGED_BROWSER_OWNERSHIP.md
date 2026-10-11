# Dedicated Chromium ownership boundary (opt-in)

This is the safe foundation for background browser work, **not a change to the installed Mecord 2.0.5 runtime**. It is a separate performance/security-review branch. The previous background-tab latency investigation is in docs/BACKGROUND_TAB_LATENCY_FINDINGS.md.

## Why ownership matters

A Chromium CDP endpoint can be supplied by a user or discovered from an existing profile. CDP browser tab activation on such an endpoint would bring a user's tab forward, which is not acceptable for silent background automation.

When the caller explicitly chooses **dedicatedProfileOnly: true**, the ManagedChromiumLauncher:

1. Requires a caller-specified **absolute, separate dataDir** outside normal Chrome/Edge user profiles and the protected .operator state tree.
2. Rejects configured endpoints, discoveryDataDirs, custom launchers/delegates, and autoLaunch: false. It never trusts an externally discovered port as proof of ownership.
3. Creates an independently spawned **headless** child with a separate profile and an ephemeral CDP port.
4. Reuses the endpoint only while its own child is alive; closes its own child before a fresh launch.
5. Refuses to delete or reuse a pre-existing DevToolsActivePort file in that directory; refuses a symlinked dedicated profile.
6. Refrains from touching user-selected tabs. Browser tab focus is **explicit**, via normal browser.tab.focus, in the independent Chrome, after ordinary authorization.
7. Preserves existing result/uncertainty classification if a native input command fails. It does not silently replay mutations or emulate focus.

All of this is **off by default**. The normal managed browser mode retains its existing behavior. Application-level enrollment, consent UI and runtime configuration remain to be reviewed before exposing this to users.

## Local synthetic verification

Run only in an isolated checkout with a separate Chrome executable; no real accounts or external submissions:

    node --experimental-strip-types scripts/verify-dedicated-browser.mjs

The smoke constructs an exclusive headless ManagedBrowserProvider with a temporary dataDir, executes a synthetic localhost navigation, explicit tab.focus, native click and independently verified text postcondition, closes the child, and deletes the profile. Original Sampath Windows test: PASS; no managed-child Chrome process or test profile remained afterward.

Supporting tests in test/browser-managed.test.ts check unauthorized endpoint injection, standard profile reuse, protected state reuse, injected delegates, stale DevToolsActivePort non-deletion, and ordinary default behavior. No installed runtime state was changed.

## Integration restriction

Only a future authorized caller that explicitly supplies a newly managed profile may enable dedicatedProfileOnly. **Do not** auto-opt a user-owned profile into dedicated mode, use focus emulation, or infer exclusive ownership from a healthy port alone. Any product feature that automatically activates internal tabs must independently obtain permission and preserve action security, audit/journal, and resource-fencing guarantees. This PR does not introduce automatic tab switching.

Performance evidence from the isolated original Sampath experiment: a 30-sample five-step workflow on an active tab in its own headless profile had p50 1,156.4 ms and p95 1,188.9 ms; inactive background-target five-step tests had p50 ~11,187 ms. These are **local** browser timings. Hosted Mecord certification and a production release require source-matched 2.0.6 deployment, monitored cross-host trace collection, and review of this ownership mode.
