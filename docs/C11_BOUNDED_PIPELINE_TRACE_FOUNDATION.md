# C11: Bounded inert pipeline latency measurement source

This first clean current-main source slice replaces the old, stacked #342 benchmark instrumentation with an **explicitly constructed, default-OFF, pure in-memory** recorder.

- Closed, known pipeline-stage and origin enums only. No network, provider action, tool input, file content, exception message, command-line, authority token or arbitrary label can be stored as a span field.
- Trace IDs are SHA-256 derived from bounded original references, not raw user/action identifiers. Span IDs are random, and nested measurements inherit the same opaque trace with a parent-span relationship.
- A fixed-capacity (1–8192) circular buffer prevents unbounded telemetry growth. Counts of discarded spans and per-stage p50/p95/max durations remain available.
- Uses a monotonic clock for elapsed durations and structured async context for nested stages. Exceptions are rethrown without serializing error text.
- Importing the module only declares APIs. It never starts timers, reads environment variables, performs disk I/O or hooks into the shipping relay. Deliberate, reviewed instrumentation and a separate isolated benchmark harness must be added later.

Synthetic tests verify default-off behavior, opaque trace correlation, nested spans, bounded memory, no sensitive error/trace leaks, quantiles and refusal of malformed stages or capacities.

No physical device or live-host performance measurement is claimed. No before/after latency number is inferred from this source-only foundation, and the old #342 integration branch remains unmerged.