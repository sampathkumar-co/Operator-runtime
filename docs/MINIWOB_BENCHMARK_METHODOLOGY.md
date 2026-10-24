# Official MiniWoB++ evaluation methodology — not yet executed

Use original MiniWoB++ task definitions and BrowserGym evaluator. Adapter only launches an isolated task, passes its ordinary goal to the production Mecord entry point, waits for terminal task state, then independently reads reward. It must not supply actions, selectors, hidden state, reward hints, task IDs, privileged page access, or benchmark-specific policy.

Baseline A: frozen current production runtime. Candidate B: new production runtime under matched model, temperature, token budgets, timeouts, 125 task definitions, seed 0, action budget and evaluation code. Document source SHA, task manifest, CLI invocations, provider, pricing, run telemetry, failed traces and score. Expand to additional fixed seeds after initial full 125. Never compare scores from different configurations as equivalent.

Historical reported 92/125, 94/125 and 102/125 are **not independently reproduced**. PR #359 contains a benchmark-only controller and must not become the production policy. This increment did not run BrowserGym, pay a model, or generate a new MiniWoB result.
