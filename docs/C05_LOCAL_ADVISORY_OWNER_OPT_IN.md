# C05: Owner opt-in for the local event advisor

The shipping local agent now contains a **default-off** source configuration adapter for `LoopbackOllamaPlanningInfluence`.

Enable it only with both owner-controlled local process environment variables:

```text
OPERATOR_LOCAL_ADVISORY_MODEL_OPT_IN=1
OPERATOR_LOCAL_ADVISORY_MODEL_ID=gemma3:1b
```

When both variables are absent, empty, or the opt-in is `0` with no model, the runtime registers **no** advisory provider. Setting a model name without `OPT_IN=1`, malformed flag values, credential-like identifiers or URL-shaped values fails closed at bootstrap. The model name never supplies a URL: the provider is fixed to the local loopback Ollama endpoint.

This is **independent** of the existing `OPERATOR_LOCAL_SUBGOAL_MODEL_OPT_IN` and `OPERATOR_LOCAL_SUBGOAL_DYNAMIC_COMPOSITION_OPT_IN` knobs. Neither feature is automatically enabled by enabling the other, and neither creates user action permissions.

After explicit activation, every advisory request still crosses the canonical TaskOrchestrator risk/policy checkpoint, exact proposal digest, Stop/Pause boundary and persisted `reserveModelBudget` before any model prompt. The model can only return event-supported vetoes and cannot authorize tools, edit files, access private task content, claim verification or replay uncertain mutations.

No original Windows device, local model process, real user approval, hosted relay or npm release was exercised by this change. The default installed runtime is unchanged until a separately authorized source-matched release/upgrade.