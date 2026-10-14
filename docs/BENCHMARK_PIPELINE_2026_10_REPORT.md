# Mecord Connect pipeline latency certification — October 2026

## Decision

The focused result-wait optimization is safe to review and integrate, but this is **not a hosted-production performance certification**. Source-matched isolated staging shows a repeatable fresh-state improvement of about 44 ms at p50 and 43 ms at p95 by waking the control request immediately after the durable result commit. A 1,000-call run does not retain that end-to-end gain because the file-backed JSON durable stores grow and rewrite increasingly large state. The previously observed hosted 1,041 ms p50 cannot be decomposed against this isolated environment, and both live MCP connector sessions currently require reauthentication.

No production service, credential, durable state, or laptop runtime was changed or restarted.

## Source and environment identity

| Item | Identity |
|---|---|
| Historical hosted measurement source | Not captured by the historical client result; current production is different |
| Current Public/Developer health source | `88113df92019bddd85ebe4538b2dd2b7951ddd5f` |
| Tracing branch baseline | `1103e818373dd798e58f2692cc983a138d1274b8` |
| Matched A/B baseline | `3cd251187e09eb2948e530f1056bbd0744b10fc1` |
| Optimized measured source | `be520640ee7c28d3dbf5797e6240a9aa224e1add` |
| Final reviewed branch source | `c1456bb98ccd7f21222c11bb15c3bdeb8509686e` |
| Runtime | Node `v22.23.2`, Windows x64 `10.0.26200` |
| Node binary SHA-256 | `0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4` |
| Path-lease helper SHA-256 | `a94b9c71184322ae50e8802a5a86187ed141d797e0c363530cf9749f85b99824` |

The isolated harness creates fresh authority, device, project, identity, pairing, session and durable-state directories. It binds only loopback ports, generates per-run random tokens, strips ambient credentials and production endpoint variables from the child environment, and removes temporary state on exit.

## Method

The integrated test path is real MCP client → MCP server process → relay control → durable delivery → WebSocket → paired local agent → local authorization/runtime → durable result service → MCP response. It uses monotonic same-process timers and client-observed end-to-end time. Cross-host durations are not subtracted. Parent and nested stages overlap, so stage sums are not additive.

The certification workload included:

- one 1,000-call sequential baseline and one 1,000-call optimized run;
- three alternating, fresh-state 100-call A/B pairs;
- fresh optimized concurrency runs at supported widths 1, 5 and 10;
- 100 repetitions per browser scenario against an isolated local fixture and real Chrome CDP;
- relay recovery, authority, replay, session-rotation, rate-limit, result-persistence and cancellation tests.

## Measured bottleneck

In the source-matched 100-call baseline, the dominant nested stages were hosted request processing (p50 255.24 ms), hosted relay round trip (228.19 ms), local request processing (109.77 ms), relay dispatch (89.36 ms), result transport (58.31 ms), relay queue (30.23 ms), and relay queue wait (15.39 ms). Actual local HTTP execution was only 0.73 ms p50.

The old control path polled durable results every 50 ms. Replacing same-process polling with a durable-commit notification removes roughly one polling quantum in fresh-state trials. The 50 ms poll remains as a compatibility fallback for cross-process/shared-store writers.

Long-run evidence identifies a second bottleneck: the current isolated file-backed durable state rewrites growing JSON documents. At 1,000 calls, hosted request processing reached 315.21 ms p50, result wait 103.82 ms and result transport 96.70 ms. This growth erased the polling improvement. A production-grade database/shared control-plane backend must be benchmarked separately; file-backed staging cannot establish its behavior.

The historical hosted p50 of 1,041 ms with local execution p50 15 ms proves most time was outside native execution, but the remaining hosted gap is unobservable in the current session. It must not be labeled relay, OAuth, or connector latency without source-matched hosted traces.

## Results

### Historical hosted observation (not source-matched to this branch)

| Metric | Result |
|---|---:|
| Success | 100/100 |
| End-to-end p50 / p95 | 1,041 / 1,400 ms |
| Maximum | 5,792 ms |
| Local execution p50 | 15 ms |

### Matched fresh-state A/B (three 100-call trials per source)

| Metric | Baseline mean | Optimized mean | Change |
|---|---:|---:|---:|
| p50 | 242.75 ms | 198.98 ms | -18.0% |
| p95 | 265.21 ms | 222.68 ms | -16.0% |
| Mean | 232.63 ms | 201.51 ms | -13.4% |
| Throughput | 4.299/s | 4.963/s | +15.4% |
| Correct calls | 300/300 | 300/300 | unchanged |
| Dropped spans | 0 | 0 | unchanged |

### Long sequential runs

| Source | Calls | p50 | p90 | p95 | p99 | Max | Throughput | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline `f2fbb930` | 1,000 | 314.61 | 449.18 | 492.00 | 543.80 | 569.27 | 2.986/s | 0 |
| Optimized `be520640` | 1,000 | 318.09 | 475.33 | 505.06 | 593.90 | 1,195.01 | 2.981/s | 0 |

The long-run result is neutral/regressive and is reported as such. It does not invalidate the measured poll-quantum removal; it demonstrates that persistent-state growth dominates this backend.

### Supported concurrency (100 calls each, fresh state)

| Width | Success | Throughput | p50 | p95 | p99 | Max |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 100/100 | 5.063/s | 192.52 | 210.90 | 238.74 | 281.79 |
| 5 | 100/100 | 7.377/s | 632.84 | 920.44 | 1,258.83 | 1,277.68 |
| 10 | 100/100 | 6.854/s | 1,389.32 | 1,767.58 | 2,459.80 | 2,615.71 |

Widths 25, 50 and 100 are not supported by the current result service's bounded 16-read out-of-order persistence window. A width-25 probe failed closed with HTTP 400. Higher loads were not forced. CPU and memory series were not captured, so they are unknown rather than zero.

### Browser scenarios (100/100 successful per listed scenario)

| Scenario | p50 | p95 | Max |
|---|---:|---:|---:|
| Navigation | 27.3 ms | 39.9 ms | 85.9 ms |
| Semantic inspection | 111.2 ms | 113.7 ms | 117.9 ms |
| Click | 360.5 ms | 389.7 ms | 408.1 ms |
| Ten-field form | 3,620.6 ms | 3,669.7 ms | 3,715.0 ms |
| Tab switch | 31.8 ms | 44.2 ms | 66.2 ms |
| Five-step foreground workflow | 1,217.3 ms | 1,239.6 ms | 1,253.4 ms |
| Safe failed-operation recovery | 220.3 ms | 223.4 ms | 255.0 ms |
| Cold / warm inspection | 109.1 / 109.4 ms | 111.1 / 111.9 ms | 112.2 / 113.1 ms |

The requested background-tab comparison was not independently certified. The browser action target is met by click, inspection, navigation, tab switching and the five-step workflow, but not by the ten-field form workload.

## Security and correctness

- Event notification occurs only after `RelayResultStore.put` completes its durable mutation.
- Wait keys bind the validated device UUID and sequence; return additionally requires the exact delivery UUID.
- Waiters are bounded at 20,000 and are removed on result, timeout, abort or read failure.
- The control service aborts waits when the request aborts or response closes.
- The existing polling path is retained for older mocks and stores; a 50 ms fallback covers shared/cross-process writers.
- Trace capacity remains opt-in, disabled by default and bounded at 65,536. Trace schemas retain only opaque IDs and allowlisted metadata.
- Benchmark tokens are random per process and ambient credentials are not inherited by the MCP child.
- The final Codex Security diff scan `7fb519b3-c423-4e0f-852a-1a460990f1b2` reviewed all four changed source files and two changed tests, with complete coverage and zero reportable findings.

Verification: production TypeScript check passed; 106/106 selected relay/tracing tests passed with an exact-source path-lease helper; the post-hardening harness smoke passed 20/20 calls and dropped zero spans. The helper build used the available .NET Framework compiler, which does not provide the repository's preferred deterministic-build evidence, so source/binary equivalence is supported by exact-source build and self-test rather than deterministic reproduction.

## Remaining gates

1. Reauthenticate both Public and Developer MCP connectors. Current attempts return `UNAUTHORIZED: This app connection requires reauthentication.`
2. Deploy this exact source to an isolated hosted MCP/relay/device staging stack with the production storage class and identity provider; do not use production as a substitute.
3. Capture OAuth/JWKS, hosted ingress, relay database, network/ack and connector-return stages on that stack.
4. Repeat at supported negotiated concurrency while collecting CPU, memory and queue-depth series.
5. Add an explicit background-tab browser comparison if it is part of the release SLO.

## Release recommendation

Open a focused PR against the tracing branch. The notification optimization preserves durable-before-return and authorization semantics and is suitable for review. Do not claim the historical hosted latency is fixed, do not merge around protected reviews, and do not deploy this benchmark branch to production until source-matched hosted staging and normal CI/review gates pass.
