# C00-06 local-only source / lost-controller trace protocol

**Scope:** safe inventory of one explicitly authorized Git checkout when its owner reconnects the original device. It never scans home directories, uploads files, calls a model or reads protected `.operator` data. `scripts/c00-local-source-inventory.mjs` is a read-only *discovery tool*, not evidence of controller recovery or release acceptance.

Run **only** from an authorized machine and checkout, without changing the installed npm `mecord-connect@2.0.6`:

```sh
node scripts/c00-local-source-inventory.mjs --root=/absolute/path/to/authorized/checkout
```

On Windows, use a full drive-qualified path. The result emits the exact local HEAD, SHA-256 path/content digests, bounded byte counts, and source candidate classes. Only after an authorized operator confirms the inventory, use `--show-paths` for relative source paths (the content is *never* exported). All exported evidence stays local unless the operator explicitly transfers it through a separate reviewed channel.

## Security properties and boundaries

- Git read-only enumeration captures tracked worktree edits, staged edits and non-ignored untracked candidate source files; identical files are deduplicated. It does not run hooks, tests, source code, or historical controller files.
- Fail closed on invalid Git root, no exact commit, Git output overflow, traversal, unexpected path/candidate limits or modified files while reading. Exclude symlinks, `.operator`, `.git`, `node_modules`, `.env`, credential-like names and other non-source files. Source bytes are SHA-256-hashed locally and are not printed.
- **Ignored files are deliberately NOT_INSPECTED**, so the results cannot prove that all unpublished or historical sources were discovered. Nor can a name match prove that the lost GPT-OSS controller has been recovered. Additional explicit owner-authorized offline review would be required for ignored/remote archives or external historical disks.
- Device identity, author, origin, chronology, Git commit ancestry and source uniqueness relative to GitHub are **NOT independently verified**. A future local-to-upstream content-hash reconciliation must separately verify exact source and provenance before import; a candidate file cannot be declared safe simply because it is unique.
- Never delete files, receipts, or legacy controller artifacts to make the inventory clean. Never replay or ACK uncertain historical actions. Benchmark-specific controller logic must remain outside production runtime.

**Acceptance:** this PR certifies *the source-only safe inventory tool and synthetic fixtures*. C00-06 stays OPEN until an authorized original-device inspection, upstream deduplication and documented disposition with evidence. C00/C01/C08 physical and release gates remain HOLD.
