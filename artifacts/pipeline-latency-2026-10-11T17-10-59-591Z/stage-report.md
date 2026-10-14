# Mecord Connect pipeline timing

SHA: dada203688ac3cd8084eab0c994e5664a753f592
Runtime: source-checkout
OS: Windows_NT 10.0.26200
Chrome: Chrome/154.0.8037.98
Machine: original-Sampath-isolated-synthetic-Chrome
Conditions: isolated headless Chrome; loopback synthetic fixture; mode=extended; repetitions=30; hosted/model excluded
Generated: 2026-10-11T17:10:59.591Z
Retained: 4589; dropped: 0

| Origin | Stage | N | Success | Mean ms | p50 | p95 | p99 | Sum ms | RTT | Retry | Reconnect | Timeout |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser | browser.operation | 363 | 0.917 | 991.11 | 104.18 | 5367.45 | 5379.20 | 359773.81 | 0 | 0 | 0 | 0 |
| browser | browser.cdp_roundtrip | 3679 | 1.000 | 83.53 | 0.80 | 12.51 | 5008.50 | 307292.82 | 3679 | 0 | 0 | 0 |
| browser | browser.dom_postcondition | 120 | 1.000 | 151.52 | 151.94 | 155.92 | 158.74 | 18181.82 | 0 | 0 | 0 | 0 |
| browser | browser.target_discovery | 361 | 1.000 | 1.31 | 1.14 | 2.66 | 3.63 | 471.44 | 361 | 0 | 0 | 0 |
| browser | browser.cdp_connection | 66 | 1.000 | 2.05 | 1.39 | 5.79 | 11.41 | 135.44 | 66 | 0 | 0 | 0 |

Unobserved: hosted.ingress_auth, hosted.validation_serialization, relay.queue, relay.dispatch, relay.network_to_device, local.request_processing, local.authorization_approval, local.journal_audit, local.resource_lease, local.capability_routing, kernel.verify_complete, relay.result_transport, hosted.response_serialization, hosted.relay_roundtrip, hosted.request_processing, local.http_execution, model.tool_overhead_observed, unobservable_gap

Nested spans overlap parents. SumMs is sampled work, not additive end-to-end duration. Cross-host wall-clock offsets, uninstrumented gaps and model overhead remain unknown.
