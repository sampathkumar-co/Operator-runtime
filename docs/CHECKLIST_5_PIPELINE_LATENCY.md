# Checklist #5 — Full pipeline latency tracing (isolated workstream)

Status: **PARTIALLY COMPLETE / hosted acceptance blocked**. This is a measurement PR, not an optimization or a release qualification. No change to installed Mecord Connect, protected state, auth/approval rules, resource fencing, or P0 integration branches.

## What this branch measures

Opt-in feature flag: OPERATOR_PIPELINE_TRACE_ENABLED=1. Disabled by default.

- Process-monotonic elapsed spans; opaque stable SHA-256 trace keys derived from known existing action/task/delivery identities.
- AsyncLocalStorage parent-child spans within each process.
- Browser action, target discovery, CDP connection and CDP command RTT, DOM settling, kernel verification.
- Local relay delivery handling, hosted-to-relay request/response duration and response JSON parsing.
- Relay dispatch and queue insertion; selected journal prepare operations.
- Hosted MCP OAuth verification and initial request conversion.
- Status/error/timeout/cancellation counters, buffer capacity and drops, payload size and network/retry counters when observable.
- Bounded in-memory ring (8,192 spans maximum); no new synchronous fsync/write on execution path.
- Machine-local stage-level p50/p95/p99, mean/min/max, counts, success, and ranked total observed stage work.
- Unmeasured stages explicitly listed; overlapping parent/child timings and clocks across different machines NEVER added or subtracted as an exact end-to-end total.

The existing durable OperationTraceStore is unchanged. This diagnostic sidecar does not replace its audit/recovery guarantees. Trace artifacts never include action inputs, form contents, URLs, cookies, credential tokens, request/response bodies, exception messages, or raw action identifiers. Only explicit whitelisted span fields are emitted.

## Repeatable tests

Run in an isolated checkout (never the running production owner state):

    node --experimental-strip-types scripts/check.ts
    node --experimental-strip-types --test test/pipeline-latency.test.ts test/browser-cdp.test.ts test/browser-cdp-connection-recovery.test.ts test/agent-kernel-operation-trace.test.ts
    npm run test:performance

An opt-in independent synthetic Chrome benchmark reuses the already established fixture:

    OPERATOR_PIPELINE_TRACE_ENABLED=1 node --experimental-strip-types scripts/benchmark-pipeline-latency.mjs

On Windows PowerShell use $env:OPERATOR_PIPELINE_TRACE_ENABLED='1' before invoking Node. The script launches its OWN temporary Chrome user profile and localhost website. Default repetitions are 30 for inspection, click and 10-field forms, with an individual cold navigation. Reports are written to a unique timestamped directory under artifacts/ and never overwrite older measurements. The script writes machine-readable stage-report.json and browser-scenarios.json plus stage-report.md.

## Local real-Chrome baseline on Sampath laptop (2026-10-11)

Source checkout at initial benchmark: 276eacd2073b80ae0efa80fcf8b8319248f5485b.
Chrome: 154.0.8037.98. Windows: 10.0.26200. Node 22.14.0.
Controlled headless loopback synthetic page, isolated Chrome profile.

| Scenario (30 samples unless noted) | p50 | p95 |
|---|---:|---:|
| Warm tab discovery | 1.2 ms | 2.6 ms |
| Warm semantic inspection | 95.2 ms | 108.8 ms |
| Warm click | 348.0 ms | 363.5 ms |
| 10-field form | 3506.7 ms | 3546.4 ms |
| Cold navigation (one sample only) | 186.3 ms | N/A |

Important: the first new stage report lost 2,310 of 6,406 spans due to its 4,096-span buffer; it is **not** an acceptable tail or contribution ranking. Capacity was increased to 8,192 before subsequent benchmarks. The older October 11 hosted 88/88 inspection aggregate is preserved separately and must not be confused with the isolated browser measurements.

Microbenchmark, not production overhead certification: 1,000 no-I/O operations measured 2.69 ms disabled versus 11.32 ms enabled in one sample; warmups and OS scheduling add noise. Strict production tracing overhead acceptance requires side-by-side matched conditions and more replicates.

## Acceptance remaining — not claimable from local code

- [ ] Source-matched hosted Developer MCP deployment instrumented and accessible for synthetic E2E verification.
- [ ] Durable, privacy-safe **cross-process correlation/export** with parent links over authenticated relay boundaries, including result transport and retry/reconnect identity.
- [ ] All 15 requested independently observed stages, including actual device network delivery, local authorization/policy/approval, full journal+audit and resource leases, capability routing, postconditions, and result return (some hooks are still absent).
- [ ] At least 30 repetitions of every required synthetic scenario (navigation, SPA, tab switching, failures/recovery, 5-step workflow, cold/warm browser sessions), with larger tail samples.
- [ ] Reconciled hosted E2E totals with explicit unreachable segments; measured ChatGPT model/tool overhead only if runtime can observe it.
- [ ] Repeat source-matched tests under security, failure and replay conditions; final CI certification.
- [ ] Production bottleneck ranking based on complete non-dropped stage evidence; hosted CI signoff.

No architectural batching or unrelated P0 fix is included.

## Source-matched corrected local stage report

Follow-up synthetic benchmark used commit 0a32475bdad430d44f139113a137699b8b5bc163 on original Sampath, Windows_NT 10.0.26200, Chrome 154.0.8037.98, Node 22.14.0. The isolated 30-repeat browser test retained **6,739 spans, 0 dropped**. Only local browser stages were exercised; hosted/relay unobserved stages remain marked missing.

| Observed local stage | Samples | p50 (ms) | p95 (ms) | sum (ms) |
|---|---:|---:|---:|---:|
| Browser operation inclusive | 392 | 347.38 | 362.11 | 119382.78 |
| DOM postcondition settling | 330 | 150.59 | 153.92 | 49677.16 |
| CDP command roundtrip | 5623 | 0.73 | 3.83 | 6883.62 |
| Target discovery | 391 | 0.98 | 1.55 | 398.60 |
| CDP connection setup | 3 | 16.34 | 16.38 | 48.86 |

Per-scenario corrected local p50: tab discovery 1.1 ms, semantic inspection 93.1 ms, click 351.0 ms, 10-field form 3511.0 ms; cold nav 202.9 ms (n=1). DOM settling is a meaningful nested share of local browser operation time; the stage sums overlap and DO NOT represent mutually exclusive or full hosted end-to-end totals. CDP command roundtrips (5,623) are Chrome protocol roundtrips only, not hosted connector network RTTs. Stage rank is **local only**; a globally ranked bottleneck list remains blocked on hosted correlated samples.

Machine-readable and Markdown reports: artifacts/pipeline-latency-2026-10-11T15-46-06-903Z/. Previous dropped-span artifact intentionally remains uncommitted.

## Paired tracing overhead — 30 matched batches

Source 0a32475bdad430d44f139113a137699b8b5bc163. In-process async no-op (not Chrome or hosted), 30 alternating-order batches of 1,000 operations per mode on Windows_NT 10.0.26200 / Node v22.14.0:
- disabled p50 0.394 ms per 1,000 operations (p95 2.846 ms).
- enabled p50 3.744 ms per 1,000 operations (p95 9.853 ms).
- paired difference p50 **0.003156 ms per operation (3.156 microseconds)**, p95 0.008880 ms per operation (8.880 microseconds).
This is low-overhead in the synthetic benchmark, not proof of bounded overhead across hosted full workloads. Machine-readable stats in artifacts/pipeline-overhead-2026-10-11T15-49-04-875Z/.

## Additional verification

- npm --prefix apps/mcp-server run check: PASS (tsc).
- node --experimental-strip-types --test apps/mcp-server/test/relay-mode-e2e.test.ts: PASS 1/1 after installing locked dependencies in isolated clone.
- Sampath's Node 22.14.0 is below the MCP server's declared minimum 22.19.0; run supported-version certification in CI or isolated environment before claiming production compatibility.

## Follow-up source-only instrumentation (after original local Chrome benchmark)

The next dedicated-branch commit adds measured authorization/policy evaluation and capability/provider ranking in runtime.ts, precise kernel resource lease acquisition in agent-kernel.ts, and HTTP result submission transport in relay-agent.ts. These are measurement-only wrappers that preserve returns/errors and existing security boundaries. The local Chrome report remains properly labeled to its own older source SHA; these extra hosted/relay/local stages require new instrumented corresponding traffic for per-stage distributions. Do not treat a stage absent from the local Chrome fixture as evidence that the hook failed.

## Correlated capture and offline aggregation — follow-up work

The full-runtime tracing remains opt-in. For an **isolated test process**, an authorized operator may set:

- OPERATOR_PIPELINE_TRACE_ENABLED=1
- OPERATOR_PIPELINE_TRACE_EXPORT_PATH=<absolute path ending in .json>
- OPERATOR_PIPELINE_TRACE_EXPORT_INTERVAL_MS=15000 (clamped to 5–300 seconds)
- OPERATOR_SOURCE_SHA=<exact process source commit>
- OPERATOR_RUNTIME_VERSION=<exact installed runtime version>
- OPERATOR_PIPELINE_MACHINE_LABEL=<non-sensitive machine label>
- OPERATOR_PIPELINE_CHROME_VERSION=<measured Chrome version, if known>

When enabled, the recorder writes a maximum 8 MiB JSON snapshot asynchronously to an atomic replacement file (not an unbounded log). In-memory retention stays capped at 8,192 spans. No new trace write is part of an authorization, policy or durable journal transaction. An invalid export destination fails without affecting user operations. Off by default.

Copy the independently collected snapshots to a controlled analysis checkout, then run:

    node --experimental-strip-types scripts/aggregate-pipeline-latency.mjs <hosted-snapshot.json> <relay-snapshot.json> <local-snapshot.json>

This writes correlated and per-stage JSON/Markdown reports; it never accesses the live device or alters the runtime. Identical, task-derived SHA-256 trace keys provide correlation across processes, including stable retries that retain the same task identity. Parent-span IDs are presently *within a process only*. Cross-host parent relationships cannot be asserted until authenticated propagation has been certified.

**Honest remaining limitations:** This does not mean the real hosted service has been instrumented and redeployed. No hosted trace snapshots have been taken against this candidate source. Browser/CDP and mocked two-process offline aggregator tests are local evidence. Network one-way delivery cannot be computed by subtracting unsynchronized server/device timestamps. The report explicitly leaves unknown durations null, and the PR must remain a draft until source-matched hosted runs, tail samples, and end-to-end reconciliation pass.

## 2026-10-11 follow-up CI correction

The original PR head failed the repository-wide network boundary audit because a latency wrapper obscured one literal bounded redirect-protected fetch call in the source. The wrapper was moved outside the helper without changing its redirect behavior, authorization, or transport semantics. The formerly failing test and the pipeline privacy/export tests passed together (21/21). The hosted client now computes its effective MCP taskId before starting the relay span, aligning trace identity across the hosted and device execution paths. Fresh full-head CI is required.
