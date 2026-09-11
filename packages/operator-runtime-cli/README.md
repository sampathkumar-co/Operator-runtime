# operator-runtime-cli

Secure one-command Windows bootstrap for Operator.

```powershell
npx operator-runtime-cli setup
```

The command downloads the current production MSIX, enforces HTTPS, verifies the exact size and SHA-256 from release metadata, checks the Windows Authenticode trust result, requires the signing certificate SHA-256 fingerprint and subject to be pinned in this npm package, installs the package, and runs `Operator.exe setup` for the current folder.

Use `--root <folder>` to authorize a different project folder. `--manifest <https-url>` supports an approved HTTPS release mirror while preserving the same pinned signer requirement.

`npx operator-runtime-cli verify` re-checks the installed package signer against the pinned production certificate and then runs the installed Operator verification command.

The bootstrap intentionally fails closed until `trusted-signers.json` contains the production certificate fingerprint and a matching signed, timestamped release has been published. Test signing certificates are never included in the npm package.
