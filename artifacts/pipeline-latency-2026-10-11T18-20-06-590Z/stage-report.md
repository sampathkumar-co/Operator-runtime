# Mecord Connect pipeline timing

SHA: dad409139837e37b491554c7e793aa83d77994a3
Runtime: source-checkout
OS: Windows_NT 10.0.26200
Chrome: Chrome/154.0.8037.98
Machine: original-Sampath-isolated-synthetic-Chrome
Conditions: isolated headless Chrome; loopback synthetic fixture; mode=extended; repetitions=30; fiveStepRepetitions=30; backgroundFlags=false; focusEmulation=false; workfl
Generated: 2026-10-11T18:20:06.589Z
Retained: 4592; dropped: 0

| Origin | Stage | N | Success | Mean ms | p50 | p95 | p99 | Sum ms | RTT | Retry | Reconnect | Timeout |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser | browser.operation | 364 | 0.918 | 161.16 | 94.95 | 362.90 | 371.81 | 58662.36 | 0 | 0 | 0 | 0 |
| browser | browser.dom_postcondition | 120 | 1.000 | 150.47 | 149.81 | 160.30 | 161.67 | 18056.65 | 0 | 0 | 0 | 0 |
| browser | browser.cdp_roundtrip | 3680 | 1.000 | 1.82 | 0.81 | 5.99 | 16.38 | 6687.86 | 3680 | 0 | 0 | 0 |
| browser | browser.target_discovery | 362 | 1.000 | 1.19 | 1.04 | 2.61 | 3.28 | 430.65 | 362 | 0 | 0 | 0 |
| browser | browser.cdp_connection | 66 | 1.000 | 2.13 | 1.37 | 5.19 | 13.04 | 140.65 | 66 | 0 | 0 | 0 |

## CDP protocol command attribution

| Command | N | p50 ms | p95 ms | p99 ms | Sum ms |
|---|---:|---:|---:|---:|---:|
| Runtime.evaluate | 1445 | 1.14 | 12.93 | 18.29 | 3846.46 |
| CDP.other | 1085 | 0.57 | 1.63 | 2.99 | 893.80 |
| Runtime.enable | 515 | 0.56 | 2.21 | 3.29 | 516.74 |
| Input.dispatchMouseEvent | 270 | 1.09 | 4.70 | 5.82 | 480.99 |
| Accessibility.getFullAXTree | 121 | 3.40 | 4.19 | 5.08 | 423.82 |
| Network.enable | 182 | 0.77 | 1.63 | 25.62 | 289.60 |
| Page.navigate | 30 | 6.09 | 9.02 | 9.26 | 193.15 |
| Page.enable | 32 | 0.68 | 4.27 | 18.58 | 43.29 |

Unobserved: hosted.ingress_auth, hosted.validation_serialization, relay.queue, relay.queue_wait, relay.dispatch, relay.network_to_device, local.request_processing, local.authorization_approval, local.journal_audit, local.resource_lease, local.capability_routing, kernel.verify_complete, relay.result_transport, hosted.response_serialization, hosted.relay_roundtrip, hosted.request_processing, local.http_execution, model.tool_overhead_observed, unobservable_gap

Nested spans overlap parents. SumMs is sampled work, not additive end-to-end duration. Cross-host wall-clock offsets, uninstrumented gaps and model overhead remain unknown.
