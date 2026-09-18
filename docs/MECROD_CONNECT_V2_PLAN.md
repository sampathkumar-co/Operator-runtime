# Mecrod Connect v2 Plan

Status: **Future phase only — do not implement until Mecrod Connect v1 is fully certified, released, and stable.**

This document records the post-v1 product direction for Mecrod Connect. It is intentionally separated from the current OCC certification/release work so v2 planning cannot destabilize the v1 execution core.

## Activation gate

v2 implementation starts only after all of the following are true:

- v1 production candidate is fully reverified and release-certified.
- required OpenAI/App Directory review gates for v1 are complete.
- npm/package distribution is operational and ownership/2FA requirements are satisfied.
- real ChatGPT end-to-end execution is proven.
- production auth, relay, device binding, approvals, audit, filesystem, Git, browser, UIA, and recovery paths are stable.
- remaining v1 P0/P1 defects are closed.
- v1 has a clearly frozen compatibility contract for capability names, approval semantics, authority boundaries, and evidence output.

Until that gate is met, v2 work is planning/design only.

## Product goal

Mecrod Connect v1 provides a secure execution layer between an AI client and an authorized computer.

Mecrod Connect v2 adds a higher-level autonomy layer so a user can give a goal instead of micromanaging individual operations.

Target interaction:

> User: "Fix this project, test it, and prepare it for deployment."

Mecrod Connect should be able to:

1. inspect the current environment;
2. decompose the goal into bounded steps;
3. select existing trusted v1 capabilities;
4. execute those capabilities through the same authority and approval system;
5. track durable progress;
6. detect failures and unexpected states;
7. recover, retry, or re-plan safely;
8. verify that the user's goal was actually completed;
9. return compact evidence of what changed and what remains unresolved.

## Architectural rule

**v2 must sit above v1. It must not replace v1.**

High-level architecture:

```text
User / AI client
      |
      v
Mecrod Connect v2
  Goal Interpreter
  Planner
  Workflow Graph
  Durable Task State
  Recovery / Re-planning
  Verification Engine
      |
      v
Mecrod Connect v1 capability layer
  file.*
  git.*
  browser.*
  ui.*
  process/tool execution
  approvals
      |
      v
Existing v1 security / authority layer
  account + device binding
  capability scopes
  authorized roots
  approval authority
  audit/evidence
  relay/session authority
```

The planner may be general. Execution authority must remain narrow, explicit, inspectable, and enforced by the existing v1 runtime.

## Non-negotiable compatibility rules

v2 must not:

- weaken or bypass v1 approval requirements;
- introduce an unrestricted `computer.do_anything` primitive;
- bypass authorized-root enforcement;
- bypass account/device/session binding;
- execute outside advertised capability scopes;
- silently convert read-only actions into write actions;
- hide destructive/open-world behavior behind a benign high-level tool name;
- alter existing v1 tool semantics without versioning and recertification;
- treat model-generated plans as trusted authority;
- allow planner state to become an alternate source of security truth;
- make successful command execution equivalent to successful task completion.

v1 remains the enforcement layer.

## Core v2 subsystems

### 1. Goal interpreter

Converts a natural-language objective into a structured goal contract.

Example fields:

- objective;
- success criteria;
- user constraints;
- allowed roots/resources;
- risk class;
- required capabilities;
- expected artifacts;
- verification requirements;
- stop/escalation conditions.

The system should explicitly distinguish user intent from planner inference.

### 2. Planner

Produces a bounded workflow rather than directly executing arbitrary actions.

The planner should support:

- hierarchical decomposition;
- dependencies;
- optional/conditional branches;
- bounded iteration;
- risk-aware ordering;
- capability availability checks;
- approval checkpoints;
- verification steps;
- rollback/recovery hints.

Plans are proposals, not authority.

### 3. Workflow graph

Represent work as a durable DAG/state machine.

Each node should record:

- stable task/node id;
- requested capability;
- normalized arguments;
- authority context;
- approval state;
- start/end timestamps;
- attempt count;
- result/evidence;
- verification result;
- retryability;
- failure classification;
- dependency state.

This should survive process restarts without duplicating irreversible work.

### 4. Durable task state

Add a v2 task journal above the existing relay/runtime state.

Requirements:

- crash-safe persistence;
- idempotent resume;
- schema versioning;
- explicit terminal states;
- bounded retention;
- account/device/session ownership;
- no raw-secret persistence;
- deterministic recovery after restart.

### 5. Recovery and re-planning

The system must differentiate:

- transient failures;
- permission failures;
- user-approval requirements;
- environment drift;
- stale UI state;
- missing dependencies;
- validation failures;
- irreversible/terminal failures.

Recovery policy should support:

- retry same step;
- refresh environment;
- choose an alternate trusted capability;
- re-plan remaining steps;
- roll back safe reversible changes;
- pause for user input;
- stop safely.

Retries must be bounded.

### 6. Verification engine

This is a major v2 differentiator.

A task is not complete because an action returned `ok`.

Completion should be established through explicit evidence, for example:

- file hash/content assertions;
- Git diff/status assertions;
- process exit + output checks;
- HTTP/health checks;
- browser DOM assertions;
- native UI semantic assertions;
- generated artifact existence/validation;
- deployment endpoint verification;
- test-suite results;
- independent postcondition checks.

The verification step should be separate from the action that caused the change whenever practical.

### 7. Semantic workflow library

After the generic planner works, introduce higher-level reusable workflow templates.

Examples:

- `project.inspect`
- `project.fix_issue`
- `project.run_and_debug`
- `repository.prepare_release`
- `website.deploy`
- `environment.setup`
- `document.prepare`
- `app.configure`

These are orchestration recipes, not privileged bypasses. They must ultimately resolve to existing governed v1 capabilities.

### 8. Capability routing

v2 should choose the best execution provider without changing authority semantics.

Examples:

- semantic browser control before raw UI automation;
- Git provider before shell Git;
- structured filesystem provider before shell filesystem mutation;
- native app automation only when a structured provider is unavailable;
- verification provider chosen independently from execution provider when possible.

### 9. Human-control model

Preserve user agency throughout long tasks.

Support:

- previewable plans for high-risk workflows;
- explicit approval checkpoints;
- pause/resume;
- stop/abort;
- editable constraints;
- progress/evidence summaries;
- clear indication of blocked versus failed versus completed state;
- no fabricated completion.

### 10. Model abstraction

The long-term execution layer should not hard-code product logic to one model family.

Define a planner interface that can accept:

- structured tool-capable model output;
- future model providers;
- policy/risk metadata;
- bounded planning budgets;
- deterministic validation of proposed steps.

Security decisions must remain local/runtime-enforced regardless of model source.

## OpenAI/App review strategy

For OpenAI distribution, keep the public MCP surface transparent and reviewable.

Recommended approach:

- maintain narrowly defined capability tools;
- preserve accurate read/write/destructive/open-world annotations;
- expose clear justifications for risky capabilities;
- do not hide broad authority behind a single generic tool;
- keep user confirmation/approval semantics visible;
- version material tool-contract changes;
- run OpenAI-required scan/review workflows against every release candidate;
- keep v2 planner/orchestration as a higher-level layer that composes reviewed capabilities.

If OpenAI review requirements change, update this section before v2 submission.

## Development phases

### V2-A — Semantic task contract

Build:

- goal schema;
- success criteria;
- planner input/output contract;
- task state schema;
- plan validator;
- dry-run/plan-only mode.

No autonomous mutation required yet.

### V2-B — Bounded planner

Build:

- hierarchical planning;
- dependency graph;
- capability routing;
- approval checkpoints;
- bounded step/iteration budgets.

Run against simulation/test fixtures first.

### V2-C — Durable executor

Build:

- workflow state machine;
- crash-safe resume;
- idempotency;
- retry classification;
- cancellation;
- checkpointing.

Use existing v1 execution primitives only.

### V2-D — Verification and completion engine

Build:

- postcondition framework;
- cross-provider verification;
- confidence/evidence aggregation;
- explicit incomplete/blocked states;
- completion proof summaries.

### V2-E — Recovery and re-planning

Build:

- environment refresh;
- alternate-strategy selection;
- bounded automatic recovery;
- rollback where safe;
- escalation to the user when authority or ambiguity requires it.

### V2-F — Cross-app workflows

Build and certify end-to-end scenarios spanning:

- filesystem;
- Git;
- terminal/processes;
- browser;
- VS Code/developer tools;
- native Windows UI.

### V2-G — Semantic workflow library

Introduce reusable high-level workflows only after generic execution/recovery has proven reliable.

### V2-H — Model-agnostic SDK/platform

Only after Mecrod Connect itself is stable:

- planner/provider SDK;
- external integration contracts;
- third-party capability providers;
- versioned policy declarations;
- developer documentation;
- compatibility certification.

## Certification requirements for v2

v2 should receive a new certification track rather than inheriting v1 certification automatically.

At minimum reverify:

- authority propagation through planner -> execution;
- approval binding;
- capability scope enforcement;
- destructive/open-world annotations;
- planner injection/adversarial prompts;
- replay/idempotency;
- task-state tampering;
- cross-account/device isolation;
- crash/restart recovery;
- stale-state handling;
- infinite-loop/step-budget controls;
- rollback correctness;
- verification spoofing;
- browser/native UI confusion cases;
- model hallucination containment;
- audit/evidence integrity;
- package/update/supply-chain changes;
- real ChatGPT end-to-end workflows;
- OpenAI review requirements current at release time.

## Initial target scenarios

The first v2 certification fixtures should be concrete and measurable.

### Scenario 1 — Repository issue repair

Goal:

> Diagnose and fix a failing project test without modifying unrelated files.

Success requires:

- inspect repo state;
- identify failure;
- edit within authorized root;
- run relevant tests;
- verify diff;
- report evidence;
- preserve unrelated work.

### Scenario 2 — Local application configuration

Goal:

> Change one application setting and prove it took effect.

Success requires:

- locate correct application/window;
- make bounded change;
- handle stale UI state;
- independently verify resulting setting.

### Scenario 3 — Website deployment

Goal:

> Build and deploy an authorized web project and verify production health.

Success requires:

- preflight repo;
- build/test;
- require approvals where necessary;
- deploy through approved mechanism;
- verify health/public response;
- stop and report if production safety conditions fail.

### Scenario 4 — Multi-app developer workflow

Goal:

> Inspect an issue, update code, run tests, review Git changes, and prepare a release summary.

This validates orchestration across structured tools without requiring unrestricted shell authority.

## Product positioning

v1:

> **Mecrod Connect — securely connect AI to your computer.**

v2 direction:

> **Mecrod Connect — the execution layer that turns AI goals into verified work on your computer.**

Do not market v2 as "AGI." The product is an execution and orchestration substrate whose usefulness can increase as connected models become more capable.

## Final rule

**Finish v1 first. Preserve the certified core. Build v2 upward, not sideways through the security boundary.**

Any proposed v2 change that requires weakening v1 authority, approval, audit, or verification guarantees should be rejected or redesigned.
