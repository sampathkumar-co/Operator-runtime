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
