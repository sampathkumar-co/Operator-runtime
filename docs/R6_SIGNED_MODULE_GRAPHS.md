# R6 Signed Multi-file Capability Modules (module graph v1)

A governed publisher can opt into a **content-addressed dependency graph** while preserving the
previous single-file `data:` module loader. The publisher's Ed25519 signature covers the
validated capability manifest, including `provenance.moduleGraph`.

## Manifest format

```json
{
  "provenance": {
    "source": "file:provider.mjs",
    "packageDigest": "<sha256 of the canonical graph descriptor>",
    "moduleGraph": {
      "entry": "provider.mjs",
      "modules": [
        { "path": "lib/helper.mjs", "sha256": "<sha256 of helper bytes>" },
        { "path": "provider.mjs", "sha256": "<sha256 of entry bytes>" }
      ]
    }
  }
}
```

Compute `packageDigest` with `verifiedModuleGraphDigest(moduleGraph)` exported from
`src/core/verified-module-graph.ts`. Paths are canonical ASCII POSIX-relative `.mjs`
paths. The entry is a file in the package root. Module declarations are sorted
lexically and cannot duplicate or collide by case. Existing single-file packages
continue to use the SHA-256 of the sole executable file as `packageDigest`.

## Runtime integrity contract

- Requires Node.js **22.15 or newer** with `node:module.registerHooks`; older runtimes
  reject a multi-file package with `CAPABILITY_MODULE_GRAPH_RUNTIME_UNSUPPORTED`.
- Governance admission and publisher signature verification are required *before* loading.
- Maximum 64 files, 8 MiB per module, 16 MiB aggregate.
- Every declared file is resolved to an existing real path inside the trusted entry
  directory, read once into memory, and matched to its signed SHA-256 before evaluating
  any module.
- Module loading uses only that verified in-memory snapshot through an isolated,
  ephemeral `operator-verified://` URL namespace. A late path swap cannot affect the
  executed source.
- ESM imports **only** resolve to declared relative modules within the same graph.
  Bare packages, `node:` builtins, `file:`, `data:`, and undeclared imports fail closed.
- On load failure or provider `close()`, graph-source references are removed. Existing
  ESM module objects cannot be forcibly unloaded by Node.js; governed capability
  revocation and operation authorization still gate executable provider calls.

## Trust boundary

**Publisher-signed modules are trusted code, not sandboxed untrusted code.**
The integrity graph constrains ESM module resolution; it does **not** confine the
module's JavaScript global environment, subprocesses, worker APIs, or other side
effects. Admission policy must grant execution only to trusted publishers.
Do not use this feature to run untrusted marketplace extensions in-process.

The R6 contract test `test/capability-module-graph.test.ts` exercises signature/digest
binding, swapped bytes, import allowlisting, undeclared imports, path escape, module
limits, and older-runtime fail-closed behavior. The CI R6 job uses Node 22.23.2
or later for the positive multi-file execution tests.
