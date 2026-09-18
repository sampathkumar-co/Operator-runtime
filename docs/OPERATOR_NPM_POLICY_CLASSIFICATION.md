# Mecord Connect npm Dual-Use Classification Decision Record

Status: **RESOLVED**
Decision date: 2026-09-18
Package: `mecord-connect`

The owner selected the conservative **DUAL_USE** classification.

Applied source:
- `packages/mecord-connect/package.json` requires `contentPolicy.class = "dual-use"`;
- `packages/mecord-connect/DISCLOSURE` is the active root disclosure;
- the release guard fails closed if the dual-use declaration is absent, including on the first unpublished release;
- published-version-history continuity checks remain enabled;
- npm CI verifies the packed artifact contains `DISCLOSURE`;
- first publication remains immutable-artifact + human interactive 2FA;
- future publication retains staged/human-2FA promotion controls where supported.

The previous DUAL_USE / NOT_DUAL_USE / NPM_CONFIRMATION choice is historical and is not an outstanding owner decision.

Remaining work is external only: npm account/scope/2FA and exact first publication/registry verification.
