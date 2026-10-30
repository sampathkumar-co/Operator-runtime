# Mecord Connect 2.0.7 npm release preparation

**Date:** 2026-10-30  
**State:** PREPARATION ONLY / NOT PUBLISHED / NOT APPROVED TO STAGE  
**Base source:** `beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4` (`main` at preparation).

## Scope and release intent

This branch raises `packages/mecord-connect/package.json` from `2.0.6` to `2.0.7` so a source-exact, independently reviewable npm release candidate can be assembled. It **does not** change the npm registry, `latest` or `next` dist-tags, signed native artifacts, hosted relay/server, globally installed npm package, or users' local `.operator` state.

Do **not** enable or update `.release/npm-runtime-stage-request.json` or run `npm publish` from an arbitrary working tree. Existing automatic workflow only triggers from the explicit release request and must continue to fail closed. Package build stamps an exact **publication commit** into `runtime/runtime-manifest.json`; a manual, unstamped package or a package built from a different SHA cannot be promoted.

## Release blocking conditions

1. **Owner trust anchor / nine gates:** `certification/wave4-owner-key.json` is `NOT_ENROLLED`. `scripts/wave4-publication-gate.mjs` requires a source-pinned, independently reviewed owner Ed25519 key; complete 134-item Wave 0–4 readiness; and a source-exact, owner-signed attestation of nine real-world acceptance gates. Evidence must be genuine, independently checked and signed by the owner. The current absence of a signer **cannot** be bypassed, fabricated or represented as success.
2. **Original-device authority conflict:** The owner laptop running npm `2.0.6` exits on relay `RELAY_AUTHORITY_CONFLICT_REVIEW_REQUIRED` after authenticating. Local receipts and journal are preserved. Main has C08 Control Center signed original-device resolution, but the required-relay failure path still exits the entire local agent. A safe, independently reviewed recovery-only startup path or another **original-authority** recovery procedure is required before claiming 2.0.7 fixes that startup. Recovery must never change or delete historic receipt/journal state, replay an uncertain mutation, rebind an action to a different authority, or acknowledge the hosted cursor without authenticated matching evidence. Do **not** bypass original-owner approval.
3. **Source-matched Windows build:** Run full PR + merged-main CI and canonical Windows native-helper build. Verify DPAPI/UIA/path-lease self-tests, locked sources and hashes, `mecord-connect doctor`, package-to-manifest version/SHA parity, `npm pack` and isolated install doctor from the exact candidate commit. No TypeScript runtime or secrets in the tarball.
4. **Hosted compatibility:** Inspect the actual production relay and MCP edge versions, supported device protocol and authority-generation state. Updating the client first must not silently require missing server capabilities or permit an unsafe recovery downgrade. Server updates are a separate authorized step, with a backup and rollback. Do not deploy the server in this npm preparation PR.
5. **Human npm approval:** After the above gates pass, use the repository's `npm-remote-release.yml` staged publication workflow on certified `main`. Check source-pinned artifact SHA-256 and npm provenance. The owner must complete npm 2FA approval for the exact staged version. Validate registry manifest and `latest` before advising a global upgrade.

## Acceptance checklist

- [x] Create independent 2.0.7 preparation branch from current main, without publishing.
- [x] Update npm package version declaration to 2.0.7 on preparation branch.
- [ ] Correct and independently validate blocked-relay local recovery usability.
- [ ] Obtain original-device owner-confirmed receipt reconciliation evidence.
- [ ] Complete and independently verify all Wave 0–4 signed evidence gates.
- [ ] Source-match compiled Windows payload and manifest to an approved merged commit.
- [ ] Run and pass the Windows package/doctor/isolated install tests on that exact commit.
- [ ] Stage the immutable npm artifact through approved provenance workflow.
- [ ] Human approve the staged version via npm 2FA.
- [ ] Confirm `npm view mecord-connect@2.0.7` and registry `latest` distribution.
- [ ] Separately plan, execute and verify server upgrade.

## Safe rollback

This preparatory branch can be closed without any user impact. Do not remove or edit `%USERPROFILE%\.operator` receipts, relay cursor, approvals or any archived original authority evidence. Stable public npm `2.0.6` and installed operator remain unchanged until genuine 2.0.7 publication and explicit installation.
