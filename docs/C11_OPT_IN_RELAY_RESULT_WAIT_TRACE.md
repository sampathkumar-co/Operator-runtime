# C11 opt-in relay-result wait stage

Follow-up to merged, default-off `PipelineLatencyRecorder` (#646). The canonical `RelayResultStore` accepts an **optional injected recorder**. No production construction passes this argument, so without deliberate source-level configuration, no timing spans are recorded and no trace IDs are computed.

For an explicitly enabled recorder, `waitFor` wraps the existing durable-commit notification and shared-backend polling path in a sanitized `relay.result_wait` / `relay-server` stage. The trace ID is HMAC-derived from a bounded `deviceId:seq:deliveryId` reference using the recorder's random process-local key. No request payload, action result, bearer token, owner process, raw delivery ID, file path or error message is stored.

The injected recorder affects **only observation**. Exact delivery matching, once-only consumption, idempotency, timeouts, AbortSignal, persistent writes, notifier cleanup and uncertain-action authority retain their existing semantics. The default-off or absent recorder avoids even the HMAC work.

Tests cover a real on-disk result commit after a pending wait, opt-in metadata, lack of secret/raw IDs, disabled/default equivalence, mismatched delivery refusal and aborted waits. This does not measure the full hosted-to-device pipeline and does not claim a real latency reduction.

No original device, npm release, production relay, automatic file export or remote state was touched.