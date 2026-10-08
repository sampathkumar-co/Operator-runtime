# Real PostgreSQL control-plane integration

This is a **live PostgreSQL 18** test harness for transactional CAS, row fencing,
generation monotonicity after expiry, atomic rollback, concurrent migrations,
and snapshot restore. The normal unit tests use a mock query client and cannot
establish these database invariants independently.

The integration suite only executes destructive setup when
`OPERATOR_REAL_PG_TEST=1` and `PGDATABASE=operator_test`. It truncates the
`mecord_control_plane` table between tests. **Never point it at production.**

## Run in an isolated throwaway database

Start PostgreSQL 18 (for example, in a disposable CI service or local Docker
container). Create database `operator_test`, user `operator_test`, and set the
following environment variables on the test runner:

```text
OPERATOR_REAL_PG_TEST=1
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=operator_test
PGPASSWORD=<ephemeral test-only password>
PGDATABASE=operator_test
```

Then from the repository root:

```bash
npm --prefix integration/postgres ci --ignore-scripts --no-audit --no-fund
node --experimental-strip-types --test integration/postgres/real-control-plane.test.mjs
```

Do not mark real-Postgres integration as verified unless that command runs
successfully against an actual PostgreSQL server. There is no local Docker daemon
available on the current audit laptop. Adding this as an automatic GitHub Actions
gate requires a GitHub authorization with permission to edit `.github/workflows`;
the current connected GitHub credential rejected such a workflow commit.
