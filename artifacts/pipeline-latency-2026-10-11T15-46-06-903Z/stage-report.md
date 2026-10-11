# Mecord Connect pipeline timing

SHA: 0a32475bdad430d44f139113a137699b8b5bc163
Runtime: source-checkout
OS: Windows_NT 10.0.26200
Chrome: Chrome/154.0.8037.98
Machine: original-Sampath-isolated-synthetic-Chrome
Conditions: isolated headless Chrome; loopback synthetic fixture; repetitions=30; hosted/model excluded
Generated: 2026-10-11T15:46:06.903Z
Retained: 6739; dropped: 0

| Origin | Stage | N | Success | Mean ms | p50 | p95 | p99 | Sum ms | RTT | Retry | Reconnect | Timeout |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser | browser.operation | 392 | 1.000 | 304.55 | 347.38 | 362.11 | 376.38 | 119382.78 | 0 | 0 | 0 | 0 |
| browser | browser.dom_postcondition | 330 | 1.000 | 150.54 | 150.59 | 153.92 | 154.72 | 49677.16 | 0 | 0 | 0 | 0 |
| browser | browser.cdp_roundtrip | 5623 | 1.000 | 1.22 | 0.73 | 3.83 | 5.85 | 6883.62 | 5623 | 0 | 0 | 0 |
| browser | browser.target_discovery | 391 | 1.000 | 1.02 | 0.98 | 1.55 | 3.50 | 398.60 | 391 | 0 | 0 | 0 |
| browser | browser.cdp_connection | 3 | 1.000 | 16.29 | 16.34 | 16.38 | 16.38 | 48.86 | 3 | 0 | 0 | 0 |

Unobserved: hosted.ingress_auth, hosted.validation_serialization, relay.queue, relay.dispatch, relay.network_to_device, local.request_processing, local.authorization_approval, local.journal_audit, local.resource_lease, local.capability_routing, kernel.verify_complete, relay.result_transport, hosted.response_serialization, hosted.relay_roundtrip, model.tool_overhead_observed, unobservable_gap

Nested spans overlap parents. SumMs is sampled work, not additive end-to-end duration. Cross-host wall-clock offsets, uninstrumented gaps and model overhead remain unknown.
