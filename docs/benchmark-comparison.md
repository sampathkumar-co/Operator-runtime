# Source-matched relay latency comparison

Baseline: `3cd251187e09eb2948e530f1056bbd0744b10fc1`  
Optimized measurement: `be520640ee7c28d3dbf5797e6240a9aa224e1add`  
Final PR source: see immutable PR head (runtime/benchmark code reviewed through `c1456bb98ccd7f21222c11bb15c3bdeb8509686e`)

Each row below is a fresh-state, sequential 100-call run on the same laptop and Node 22.23.2 binary.

| Trial | Baseline p50 | After p50 | Baseline p95 | After p95 | Baseline throughput | After throughput |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 245.74 ms | 205.30 ms | 269.50 ms | 223.65 ms | 4.216/s | 4.872/s |
| 2 | 240.40 ms | 196.44 ms | 262.81 ms | 221.97 ms | 4.340/s | 5.021/s |
| 3 | 242.11 ms | 195.20 ms | 263.32 ms | 222.42 ms | 4.342/s | 4.996/s |
| Mean | 242.75 ms | 198.98 ms | 265.21 ms | 222.68 ms | 4.299/s | 4.963/s |

All 600 calls succeeded and no trace spans were dropped. The improvement is 18.0% at p50, 16.0% at p95 and 15.4% in throughput.

The source of the gain is narrow: the control service no longer waits for the next 50 ms polling tick after its in-process durable result store commits. It still polls every 50 ms as a cross-process/shared-writer fallback. Durable writes, delivery fencing, replay authority, result validation and audit behavior are unchanged.

The 1,000-call comparison did not improve: p50 was 314.61 ms before and 318.09 ms after. Growing file-backed JSON state dominates the long run. This is why the recommendation is “safe optimization, hosted certification pending,” not “relay fixed.”

Historical hosted results are intentionally excluded from the percentage calculation because they came from a different source and environment.
