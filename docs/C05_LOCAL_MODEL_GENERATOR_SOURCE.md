# C05: Optional local Ollama proposal generator (source only)

This adapter implements the existing `ModelGoalGenerator` interface from `bounded-model-goal-inference.ts`. It does not replace `model-goal-proposal.ts`, the trusted reviewed intake, or the canonical one-use review registry.

- **Fixed loopback target:** `http://127.0.0.1:11434/api/generate`. No arbitrary URL, redirect, cookie, credentials, browser profile or model-provider secrets.
- **Constrained request:** explicitly selected model ID, minimized prompt of at most 16 KiB, fixed JSON output mode, no streaming tools/actions, deterministic temperature zero, max 64–4096 suggested tokens.
- **Bounded read:** at most 64 KiB HTTP envelope and 32 KiB JSON text, strict 12-second maximum request deadline, abort propagation and cancellation even if a mocked transport ignores AbortSignal. No uncontrolled error text returned.
- **Runtime integration intentionally NOT done:** `BoundedModelGoalInference` must still require explicit transfer consent and a durable pre-reserved cost ledger; `TrustedReviewedModelTaskIntake` still requires a trusted native reviewer, current principal authorization and canonical task submitter. Neither this adapter nor a model response executes tasks.
- **Evidence:** isolated synthetic mock-transport tests exercise payload, fixed endpoint, denial of bad IDs/scopes, cancellation, timeouts, oversize and malformed responses. Real Ollama, user Windows laptop, physical tasks, production signoff, npm release and VPS activation are NOT_RUN.

The environment does not automatically use Ollama merely because this source module exists. No external inference endpoint is configured here.