# Matched-pair tracing overhead (synthetic, local only)

Source SHA: 0a32475bdad430d44f139113a137699b8b5bc163
Node: v22.14.0
OS: Windows_NT 10.0.26200
Workload: 30 alternate-order batches Ã— 1000 async no-op operations each, per mode.

| Mode | p50 batch ms | p95 batch ms | p99 batch ms |
|---|---:|---:|---:|
| Disabled | 0.394 | 2.846 | 2.889 |
| Enabled | 3.744 | 9.853 | 10.889 |
| Paired difference | 3.156 | 8.880 | 9.238 |

- Single-machine microbenchmark: OS scheduling, JIT and GC can affect percentiles.
- Does not measure production network, disk audit writes, Chrome, hosted or model overhead.
- Negative per-batch deltas are retained without clipping.
