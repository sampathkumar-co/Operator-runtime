# Mecord Benchmark Program

This directory records reproducible benchmark inputs and results for the Stage 21 competitive-evaluation effort.

## Rules

1. External leaderboard claims require the official benchmark environment and scorer.
2. Every result must bind to an exact Mecord source commit, runtime version, benchmark version, environment configuration, and evidence.
3. Claimed success and independently verified success are recorded separately.
4. Failed environment bootstrap is not a benchmark failure and must not be converted into a score.
5. No benchmark-specific production shortcuts, hidden task solutions, or manual rescue are allowed in ranked runs.
6. Baseline runs happen before tuning. Holdout tasks must be retained to detect overfitting.

## Initial baseline

The first frozen internal baseline is:

- Mecord source: `f2b002a15eef1aa432c4c03e4d35c533dc1cef92`
- npm runtime: `mecord-connect@2.0.1`
- public MCP: 9 tools
- Developer MCP: 32 grouped tools
- internal performance + Stage-18 evaluation: 9/9 passed

See `results/internal-baseline-f2b002a-20260928.json` for measured timings.

## External suites

The program targets:

- OSWorld
- OSWorld V2
- WindowsAgentArena
- BrowserGym / MiniWoB first, then WebArena Verified and WorkArena

External suites are pinned in `manifest.json`. A score is added only after the official scorer runs successfully.
