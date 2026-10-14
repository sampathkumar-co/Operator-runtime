# Isolated Mecord pipeline benchmark runbook

## Safety boundary

Run only in a disposable worktree. Do not point any variable at production URLs, credentials, databases, relay state or device state. The harness creates temporary paired identities and loopback-only services and deletes temporary state on exit. Generated evidence belongs under `artifacts/` and must not be committed.

## Prerequisites

- Windows x64.
- A supported Node 22 executable; certification used Node 22.23.2.
- Exact-lock dependencies installed with `npm ci` in `apps/mcp-server` and `apps/relay-server`.
- For real Windows filesystem E2E tests, build the helper from the same checkout with `native/windows-path-lease/build.ps1`, run its self-test, and set `OPERATOR_WINDOWS_PATH_LEASE_PATH` to the absolute built executable.

Record before each run:

```powershell
git rev-parse HEAD
& $BenchNode --version
Get-FileHash $BenchNode -Algorithm SHA256
Get-ComputerInfo | Select-Object OsName,OsVersion,OsBuildNumber
```

## Integrated simple-call benchmark

Use an explicit Node path without changing the global runtime:

```powershell
$BenchNode = 'C:\path\to\node-v22.23.2\node.exe'
$env:MECORD_BENCH_REPS = '1000'
$env:MECORD_BENCH_CONCURRENCY = '1,5,10'
$env:MECORD_BENCH_CONCURRENCY_SAMPLES = '100'
& $BenchNode --experimental-strip-types apps/mcp-server/scripts/benchmark-integrated-pipeline.ts
```

The script prints its evidence directory. Preserve `benchmark-results.json`, `benchmark-stage-latency.csv`, `hosted-snapshot.json` and `sequential-checkpoint.json`. Confirm the JSON source SHA equals `git rev-parse HEAD`, all requested calls succeeded, and `tracing.droppedSpans` is zero.

Concurrency above 16 is deliberately not executed by the harness because the current result service has a bounded 16-read out-of-order window. Do not bypass that safety boundary.

## Browser benchmark

Use the repository browser benchmark with a disposable Chrome profile and its isolated localhost fixture. Never navigate it to a real account or private page. Run at least 100 repetitions and preserve `browser-scenarios.json`, `stage-report.json` and `stage-report.md`. Verify fixture postconditions independently for navigation, inspection, click, form input, tab switching, multi-step workflow and failure recovery.

## Regression verification

```powershell
$env:OPERATOR_WINDOWS_PATH_LEASE_PATH = 'C:\absolute\path\operator-windows-path-lease.exe'
& $BenchNode apps/mcp-server/node_modules/typescript/bin/tsc -p tsconfig.production.json
& $BenchNode --experimental-strip-types --test test/pipeline-latency.test.ts test/relay-result-store.test.ts apps/relay-server/test/*.test.ts
```

The certification result was 106/106 tests. The suite covers authorization, developer entitlement, delivery identity, safe retry, replay prevention, session rotation, stale authority, rate limits, durable results, cancellation and trace privacy/bounds.

## Hosted staging

Deploy the exact reviewed SHA to a dedicated hosted MCP, relay/control service, storage namespace and paired test device. Record service image digests, runtime hashes, database/storage class and identity-provider configuration. Use a dedicated test account. Collect same-host monotonic spans independently on each host and client-observed end-to-end time; never estimate cross-host one-way time from unsynchronized clocks.

Production is not a fallback staging environment. Stop if an isolated hosted stack, protected review, or connector reauthentication is unavailable.

## Cleanup

Stop only processes started by the harness. The integrated script closes its own services and removes its temporary identity/state directories. Retain the selected evidence directory, then remove only known disposable benchmark artifacts and Chrome profiles. Never delete a repository root, shared state directory, production durable state or another agent's worktree.
