# Mecord Connect npm Software License Decision Record

Status: **RESOLVED**
Decision date: 2026-09-18
Package: `mecord-connect`

The owner selected **PROPRIETARY** licensing.

Applied source:
- `packages/mecord-connect/package.json` declares `"license": "SEE LICENSE IN LICENSE"`;
- `packages/mecord-connect/LICENSE` is the active package-root license;
- the active package license identifies **Kinthala Samuel Sampath Kumar** as Licensor;
- the package README explicitly points users to the proprietary Mecord Connect Runtime License;
- npm CI fails closed if the license metadata/file is removed and verifies the packed tarball contains `LICENSE`.

The previous UNLICENSED/proprietary-vs-Apache-vs-MIT decision state is historical and no longer an open release decision.

Remaining work is external only: publish the exact certified tarball through the owner npm account/2FA flow and verify the public registry/clean-machine install.
