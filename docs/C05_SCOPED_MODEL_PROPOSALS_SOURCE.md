# C05 Scoped Model Proposal Grammar (Source-Only)

This current-main increment ports the unshipped unique `task-goal-interpreter` model proposal/validation module from the old stacked #361–#367 lineage. **No HTTP endpoint, local-agent wiring, automatic task submission, provider approval, or production AI execution is added.** The mainline already has a separate hardened `TaskProposalReviewRegistry`; this PR intentionally does not overwrite that stronger current code.

Proposal grammar: user-selected HTTP(S) browser origins, exact explicitly selected absolute project roots (not speculative descendant paths), registered test/lint/build proposals, 2–4 distinct scoped steps, all-checks quality gate, and 1–5 observable success conditions. Local Ollama adapter is opt-in for future callers and bound to loopback with short timeout, AbortSignal and response-size limits. All proposed goals must be validated and reviewed separately before any authenticated runtime task creation. These safeguards do not replace canonical kernel permission checks, path realpath inspection, task execution receipts or release acceptance.

Security additions over the historical draft: inert plain-object and dense-array descriptor validation (no user getter/coercion callbacks), literal commandKind checks, exact selected root matching, absolute path requirements, pre-prompt scope validation and adversarial fixtures for foreign origins/shells, unapproved paths, accessors and forged fields.

Status: SOURCE CODE CANDIDATE. CI/physical/release acceptance are independent and no installed runtime has changed.
