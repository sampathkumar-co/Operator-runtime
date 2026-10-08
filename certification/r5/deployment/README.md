# R5 persistent-host campaign bundle

This directory launches the real Operator relay executable twice against one PostgreSQL control plane. Both relays have separate local identity/state volumes while delivery, result, idempotency, and cluster-fencing records use PostgreSQL. A third container appends source-bound health observations to a durable evidence volume.

The bundle does **not** turn a disposable Codex task into a 72-hour environment. Run it only on an authorized host whose storage and supervisor survive logout and reboot. No cloud account or paid service is provisioned by these files.

## Host preflight

- Linux host with Docker Engine and Compose v2.
- At least 20 GiB free durable storage and four GiB RAM.
- NTP active, host reboot access, and an operator available for physical reboot/sleep scenarios.
- Repository checked out at the immutable commit to certify, with no working-tree changes.
- Backup destination on storage independent of the PostgreSQL volume.
- No other Compose project named `mecord-r5-certification`.

The PostgreSQL and Node base images are digest pinned. The controller installs the lockfile-pinned relay dependencies on the Linux host before building; the image prunes development-only packages without network access. No service publishes a host port; the topology is isolated on an internal Docker network. PostgreSQL receives its generated password through a Compose secret file. Relay containers run read-only, non-root, without Linux capabilities or privilege escalation.

Before moving the checkout to the persistent host, verify the exact bundle locally. This creates a separate disposable Compose project, waits for every health check, and removes only its own containers and volumes:

```bash
node certification/r5/deployment/campaign-control.mjs smoke
```

## Start and recovery

From the repository root:

```bash
node certification/r5/deployment/campaign-control.mjs start
node certification/r5/deployment/campaign-control.mjs status
```

`start` refuses a dirty tree, records the exact 40-character Git SHA and UTC start time, creates a 256-bit PostgreSQL password with mode `0600`, builds the source-bound image, and waits for PostgreSQL, both clustered relays, and the monitor. The local `state/` directory is ignored by Git and must itself be backed up by the host.

After a host reboot, use:

```bash
node certification/r5/deployment/campaign-control.mjs resume
```

This reuses the original campaign identity and start time. It never creates a replacement campaign. `stop` records the actual stop time and leaves all named volumes intact:

```bash
node certification/r5/deployment/campaign-control.mjs stop
```

Do not use `docker compose down --volumes`; destroying campaign volumes invalidates the soak.

## Required fault campaign

The operational run remains uncertified until raw artifacts prove every evaluator fault class:

1. Kill one relay during an in-flight transition; show the other relay fences the stale owner and recovery does not duplicate the mutation.
2. Insert a network fault proxy and exercise partition, reorder, and duplicate delivery independently.
3. Reboot the host, exercise sleep where supported, and inject bounded clock offset into a sacrificial relay container.
4. Exhaust a bounded sacrificial filesystem while PostgreSQL and relay writes are active.
5. Remove write permission from a sacrificial relay state volume.
6. Corrupt a copied state artifact and prove fail-closed detection; never corrupt the only live database.
7. Drive event growth beyond the expected retention window and prove bounded pruning.
8. Run `pg_dump` while mutations continue and retain its logs and digest.
9. Restore that dump to an isolated database and compare canonical table content.
10. Start a third worker with a conflicting resource claim and prove generation fencing.
11. Deploy a deliberately unhealthy next image and prove staged rollout halt and rollback.

Every injection needs before/after timestamps, the exact command or controller version, health journal slices, operation traces, database observations, and a SHA-256 digest. A fault is not passed merely because containers became healthy again. Never inject destructive disk/corruption tests into the only copy of campaign state.

## Evidence and certification boundary

The monitor writes `/evidence/health.jsonl` in the named evidence volume. The PostgreSQL volume and both relay state volumes are durable Compose volumes. Export them and the Docker event/log stream to the independent verifier host at least daily. The final campaign object must be derived from raw observations and evaluated with:

```bash
node --experimental-strip-types scripts/evaluate-r5-operational-campaign.ts path/to/campaign.json
```

The evaluator requires a real 72-hour interval, all eleven fault classes, three or more external evidence artifacts, 100% visible-operation trace coverage, coherent restore, safe multi-instance state, rollback proof, and every production SLO. Repository tests or a short deployment smoke test are not substitutes.
