# Mecord Connect pipeline timing

SHA: 6820140fe9f7502c89d219a50fdd056c66cb60aa
Runtime: source-checkout
OS: Windows_NT 10.0.26200
Chrome: Chrome/154.0.8037.98
Machine: original-Sampath-isolated-synthetic-Chrome
Conditions: isolated headless Chrome; loopback synthetic fixture; mode=extended; repetitions=30; hosted/model excluded
Generated: 2026-10-11T17:16:38.456Z
Retained: 4592; dropped: 0

| Origin | Stage | N | Success | Mean ms | p50 | p95 | p99 | Sum ms | RTT | Retry | Reconnect | Timeout |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser | browser.operation | 364 | 0.918 | 161.05 | 95.65 | 360.88 | 369.54 | 58623.69 | 0 | 0 | 0 | 0 |
| browser | browser.dom_postcondition | 120 | 1.000 | 149.54 | 148.39 | 158.56 | 160.36 | 17944.27 | 0 | 0 | 0 | 0 |
| browser | browser.cdp_roundtrip | 3680 | 1.000 | 1.77 | 0.79 | 5.88 | 14.54 | 6527.17 | 3680 | 0 | 0 | 0 |
| browser | browser.target_discovery | 362 | 1.000 | 1.19 | 1.01 | 2.59 | 3.43 | 432.28 | 362 | 0 | 0 | 0 |
| browser | browser.cdp_connection | 66 | 1.000 | 2.11 | 1.31 | 6.12 | 15.12 | 139.34 | 66 | 0 | 0 | 0 |

## CDP protocol command attribution

| Command | N | p50 ms | p95 ms | p99 ms | Sum ms |
|---|---:|---:|---:|---:|---:|
| Runtime.evaluate | 1445 | 1.11 | 12.93 | 16.87 | 3762.60 |
| CDP.other | 1085 | 0.58 | 1.67 | 2.77 | 867.29 |
| Runtime.enable | 515 | 0.55 | 2.15 | 2.71 | 487.02 |
| Input.dispatchMouseEvent | 270 | 1.07 | 4.57 | 5.94 | 465.95 |
| Accessibility.getFullAXTree | 121 | 3.36 | 4.48 | 4.99 | 426.13 |
| Network.enable | 182 | 0.79 | 1.75 | 26.60 | 277.42 |
| Page.navigate | 30 | 6.12 | 8.09 | 8.88 | 191.93 |
| Page.enable | 32 | 0.71 | 3.39 | 23.78 | 48.83 |

Unobserved: hosted.ingress_auth, hosted.validation_serialization, relay.queue, relay.dispatch, relay.network_to_device, local.request_processing, local.authorization_approval, local.journal_audit, local.resource_lease, local.capability_routing, kernel.verify_complete, relay.result_transport, hosted.response_serialization, hosted.relay_roundtrip, hosted.request_processing, local.http_execution, model.tool_overhead_observed, unobservable_gap

Nested spans overlap parents. SumMs is sampled work, not additive end-to-end duration. Cross-host wall-clock offsets, uninstrumented gaps and model overhead remain unknown.
