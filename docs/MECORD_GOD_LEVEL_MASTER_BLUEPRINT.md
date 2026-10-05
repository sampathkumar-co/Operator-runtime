# Mecord God-Level Master Blueprint

Date: 2026-10-05  
Repository: `sampathkumar-co/Operator-runtime`  
Assessment snapshot: `integration/adaptive-plan-runtime-20261005` at `ed20ca3948d459f93f81deae4cc9c4f533dc143f` plus the concurrent uncommitted `TaskShadowObserver` integration in `src/core/task-orchestrator.ts`  
Purpose: complete technical, product, operational, and long-range roadmap after the Adaptive Intelligence and Verified Plan Runtime foundations are integrated  
Separate workstream: detailed bug/security findings remain owned by the concurrent deep audit and must be imported as release-gate inputs

## 1. The north star

Mecord should become the trusted operating layer between intelligent agents and real systems.

It should not try to be the foundation model. It should make any authorized model or agent safer, more durable, more observable, more recoverable, and more effective when operating computers, repositories, browsers, services, and fleets.

The target promise is:

> Give an agent a bounded objective. Mecord will compile it into a constrained plan, acquire only the necessary authority, simulate or preview consequences where possible, execute through the safest available mechanism, independently verify the result, recover honestly from failure, and produce proof that another human or machine can inspect.

The mature system should answer seven questions for every meaningful action:

1. Who requested it?
2. Under whose authority?
3. For which objective?
4. Against which exact resource and observed state?
5. Why was this mechanism selected?
6. What actually changed?
7. What independent evidence proves the outcome?

## 2. What exists today

This repository already contains much more than a remote-control connector.

### 2.1 Trust and execution foundation

- action identity and transition journals;
- authority, policy, provenance, canonical risk, approvals, and emergency stop;
- side-effect certainty, compensation journals, durable sagas, reconciliation coverage, and verification kernels;
- intent versioning and conversation ledgers;
- resource identity and leases;
- state snapshots and release/update controls;
- tamper-aware audit and evidence structures.

### 2.2 Durable autonomy foundation

- Task Capsules and durable plans;
- semantic planners and decision budgets;
- task recovery, re-observation, postconditions, and verification;
- multi-worker team missions, leases, resources, CAS state, and verifier gates;
- organization rollout coordination;
- Stage-10 outcome operations;
- Studio teach/execute and desired-state reconciliation;
- durable events and tickers.

### 2.3 Knowledge and perception foundation

- world model and temporal history;
- perception graph and publication;
- procedure memory;
- bounded execution optimizer and provider learning;
- semantic checkpoints and migration proofs;
- evaluation fabric.

### 2.4 Computer and developer capabilities

- safe filesystem inspection and mutation;
- Git inspection, checkpointing, and governed writes;
- trusted project commands and rollback transactions;
- bounded process and terminal execution;
- browser CDP observation, navigation, interaction, and verification;
- Windows UIA and bounded visual/physical fallback;
- Docker, PostgreSQL, VS Code, and sandboxed-compute adapters.

### 2.5 Product and transport foundation

- local agent with a large authenticated HTTP surface;
- public and Developer MCP surfaces;
- paired-device relay, results, enrollment, reset, and recovery;
- Windows packaging and native Rust helpers;
- public edge, OAuth, legal/reviewer/release infrastructure;
- CI spanning core, stage certification, red-team, performance, MCP, relay, Windows, package, container, and platform gates.

### 2.6 Incoming intelligence foundations

Two large successor packages are now present but are not yet fully integrated into production execution.

#### Adaptive Intelligence Core

Provides:

- explicit epistemic states;
- causal transitions;
- hierarchical hypothesis and failure attribution;
- progress semantics;
- counterfactual recovery;
- anti-loop strategy selection;
- observation policy;
- trajectory integrity/compression;
- skill schema and receipt-gated learning;
- evaluation freeze, shadow comparison, calibration, and promotion gates.

Independent qualification result on this assessment snapshot: **189 tests passed, 0 failed**.

#### Verified Plan Runtime

Provides:

- goal and hard/soft constraint compilation;
- hierarchical plan graphs;
- belief-bound readiness;
- branch choice, ranking, and bounded lookahead;
- execution-mode compilation;
- local repair and plan revision;
- infeasibility reasoning;
- irreversible-action commit protocol;
- plan/decision/receipt lineage;
- verified reusable plan fragments.

Independent qualification result on this assessment snapshot: **61 tests passed, 0 failed**.

These results establish package-level credibility. They do not yet establish safe production integration.

### 2.7 Immutable committed-runtime validation

The committed `ed20ca3948d459f93f81deae4cc9c4f533dc143f` tree was exported into an isolated snapshot so the concurrent uncommitted integration was not touched. After supplying the snapshot with the required packaged Windows path-lease helper, the complete root suite passed:

- batch 1: 487 tests, 475 passed, 12 platform/permission skips, 0 failed;
- batch 2: 391 tests, 383 passed, 8 platform/permission skips, 0 failed;
- batch 3: 32 tests, 32 passed, 0 skipped, 0 failed;
- total: **910 tests, 890 passed, 20 skipped, 0 failed**.

The first isolated attempt intentionally lacked the native helper and failed closed in Windows filesystem-dependent tests. Supplying the same built helper expected by the packaged runtime made the immutable snapshot green. This confirms the committed baseline under its required native boundary; it does not certify the still-changing uncommitted integration.

## 3. The central architectural problem

Mecord has most of the necessary concepts, but several exist in overlapping forms:

| Concern | Existing runtime | Incoming packages | Required convergence |
|---|---|---|---|
| Plan representation | `task-plan`, outcome planner, team work graphs | verified plan graph/runtime | One canonical plan identity and lifecycle |
| Epistemic state | core epistemic mapping, world/perception claims | adaptive epistemic engine | One vocabulary and adapter, no competing truth stores |
| Progress | task events and verifier state | adaptive progress engine | Advisory progress until independently verified |
| Failure reasoning | task failure/recovery paths | hypothesis/failure attribution | Adaptive diagnosis recommends; runtime controls |
| Strategy learning | optimizer/provider learning/procedure memory | learning firewall and strategy engine | One promotion authority and receipt lineage |
| Verification | canonical/task/action verification kernels | plan-node receipts and outcome contracts | Existing verification remains final authority |
| Persistence | file-backed runtime stores | versioned package envelopes | Shared schema/migration/catalog lifecycle |
| Identity | task/action/resource/intent IDs | goal/plan/node/trace/run IDs | One hierarchical execution identity graph |

If integration merely imports both packages into `TaskOrchestrator`, Mecord will develop split-brain planning, duplicated state, inconsistent identities, and unclear recovery ownership.

The correct integration is a control hierarchy:

```text
Goal Contract
    |
    v
Verified Plan Runtime proposes and maintains plan state
    |
    v
Adaptive Intelligence diagnoses, estimates progress, and recommends recovery
    |
    v
Task Orchestrator selects an allowed next transition
    |
    v
Agent Kernel + Authority Kernel authorize exact action
    |
    v
Resource leases + provider execute
    |
    v
Reconciliation + Verification Kernel establish truth
    |
    +--> authoritative receipt updates plan
    +--> bounded evidence updates adaptive state
```

Planning and adaptive reasoning are advisory above the authority boundary. Verification receipts are authoritative below it.

## 4. Non-negotiable system invariants

Every future improvement must preserve these invariants.

### Authority

- Delegation is attenuation-only.
- A plan, model, learned skill, workflow, or role never grants authority.
- The exact newest intent, authority version, action identity, target identity, and resource lease must bind each mutation.
- An approval cannot be replayed for another action, target, state, plan node, or attempt.

### Execution truth

- Successful transport or provider return is not task success.
- Unknown and uncertain effects remain explicit.
- An uncertain mutation is reconciled before retry or branch switching.
- Irreversible actions require fresh authority, explicit preflight, and independent postconditions.

### Planning

- Hard constraints cannot be traded for utility.
- Replanning cannot rewrite successful history or unresolved side effects.
- Belief and plan revision identities are immutable and lineage-bound.
- Infeasibility is evidence-backed, not a planner excuse.

### Learning

- Learning cannot change authority, risk, scope, approval, or verification rules.
- Only independently verified outcomes may promote reusable behavior.
- Evaluation and benchmark runs cannot contaminate production learning.
- Confidence must remain calibrated and sample-aware.

### Product truth

- Deployed, packaged, documented, and registry versions must agree through one release ledger.
- Unsupported platforms or workflows must be described honestly.
- A blocked or inconclusive operation may never be presented as completed.

## 5. Replace the old “Stage 21–40” framing

The repository already contains a planned Stage 21–40 roadmap. Much of it was written before later implementation accelerated. Several “future” stages now substantially overlap with existing code.

| Old planned stage | Current 2026-10-05 reality | Correct next step |
|---|---|---|
| 21 Agent identity/authority graph | Partial foundations exist across provenance, intent, task, action, account/device, and teams | Unify into one principal/delegation graph |
| 22 Intent-bound capability leases | Capability policy, task scope, resource leases, approvals already exist | Add explicit purpose/intent binding and delegation attenuation |
| 23 Transactional execution | Project transactions, sagas, journals, checkpoints, compensation, reconciliation exist | Generalize one transaction contract across providers |
| 24 Evidence/provenance ledger | Audit, evidence, rendered evidence, verification receipts exist | Build content-addressed Evidence Packs and query/index layer |
| 25 Outcome verification runtime | Already a major implemented strength | Standardize verification contracts and external verifier SDK |
| 26 Multi-agent isolation | Team coordination and leases exist | Add workspace/process/port/container isolation and developer UX |
| 27 Reactive event fabric | Durable events and tickers exist | Add authenticated external subscriptions, causal delivery, and backpressure |
| 28 Continuity/fault tolerance | Tasks, sagas, checkpoints, reconnect, reconciliation exist | Prove long-duration behavior and multi-instance recovery |
| 29 Universal agent gateway | MCP and Developer/public surfaces exist | Add transport-neutral SDKs/adapters and version negotiation |
| 30 Trust control plane | Enterprise policy, organizations, devices, audit exist | Productize fleet/policy/admin and scale the hosted plane |
| 31 Intent compiler | Outcome/task planners plus Verified Plan Runtime exist | Converge into one goal-to-plan compiler |
| 32 Counterfactual digital twin | Mostly absent | Build after Workspace Graph and hermetic execution exist |
| 33 Formal safety/proof kernel | Deterministic verification/invariants exist, but not a unified proof vocabulary | Add proof claims, trust levels, and machine-checkable proof bundles |
| 34 Self-healing fabric | Recovery, reconciliation, optimizer, adaptive recovery exist | Add health model, automated component repair, and canary rollback |
| 35 Distributed compute mesh | Device pool and organization placement exist | Add multi-node scheduler, data locality, isolation, and capacity control |
| 36 Dynamic capability synthesis | Capability SDK exists; synthesis/certification absent | Add generate-sandbox-test-review-promote pipeline much later |
| 37 Causal engineering memory | World/procedure/history plus adaptive causal graph exist | Create evidence-bound developer memory over Workspace Graph |
| 38 Adversarial agent defense | Strong policy/red-team boundary exists | Add runtime provenance scoring and prompt/repository instruction isolation |
| 39 Certification network | Evaluation and extensive certification exist | Create standardized public/private certification packs and comparative runs |
| 40 Autonomous Engineering OS | Components exist separately | Integrate only after product, scale, and proof layers converge |

Therefore, the future should be managed as maturity releases rather than more numbered subsystem stages.

## 6. Maturity releases

## R1 — Canonical Trusted Runtime

Time horizon: 0–8 weeks

Goal: make the current system reproducible, comprehensible, statically checked, and governed from one source of truth.

### Required work

- reconcile remote `main`, deep-hardening, release 2.0.5, and current integration histories;
- preserve and merge parallel deep-audit fixes through regression-backed PRs;
- create one canonical workspace and archive historical clones only after unique-state verification;
- introduce root workspaces and strict TypeScript project references;
- split the largest monoliths without behavior changes;
- generate all release/version/deployment claims from one ledger;
- define stable contracts for intent, goal, plan, action, evidence, receipt, artifact, and event identities;
- create architecture decision records and compatibility policy;
- restructure CI into fast PR, integration, nightly, and release lanes.

### Exit criteria

- all production TypeScript is type-checked;
- one canonical branch produces every package and deployment artifact;
- no unexplained code exists only in a laptop clone;
- schemas support current and previous-version compatibility tests;
- median PR feedback is below ten minutes;
- complete qualification and rollback evidence are reproducible.

## R2 — Integrated Adaptive Planning Runtime

Time horizon: 1–4 months

Goal: integrate the two incoming features without allowing them to bypass or duplicate the trusted execution path.

### Integration phases

#### R2.1 Contract integration

- define a canonical `ExecutionContextIdentity` containing account, device, session, conversation, intent, task, goal, plan, node, action, attempt, authority version, resource revision, and evaluation-run identity;
- build explicit adapters between core observations/evidence and package belief/evidence contracts;
- map package recommendations into a closed advisory command vocabulary such as `OBSERVE`, `REGROUND`, `REPLAN`, `REPAIR`, `RECONCILE`, `WAIT`, `VERIFY`, and `FAIL_SAFE`;
- version every envelope and register it in the persistent-data catalog.

#### R2.2 Shadow observation

- emit bounded decision/outcome events from `TaskOrchestrator`;
- prohibit raw credentials, unrestricted DOM, commands, or file content in shadow storage;
- run both successor packages without changing authoritative decisions;
- compare control and shadow recommendations using frozen cohorts;
- add kill switches, sampling, retention, and per-session opt-in.

#### R2.3 Advisory production

- allow adaptive output to request additional observation or recommend user escalation;
- allow verified planning to rank read-only plan nodes;
- keep the existing task planner authoritative;
- require evidence that recommendations reduce loops or false progress.

#### R2.4 Reversible control

- allow low-risk, reversible action ordering only;
- require exact authority and resource envelopes from the existing runtime;
- require rollback/checkpoint availability and independent verification;
- canary by capability, not by all-or-nothing runtime switch.

#### R2.5 General control

- permit bounded replanning and recovery only after shadow/advisory/canary thresholds pass;
- retain hard runtime veto at every action;
- high-risk and irreversible operations require fresh production receipts and explicit user/policy authority.

### Promotion metrics

- verified completion improvement;
- false-completion change;
- user-correction change;
- repeated-equivalent-failure rate;
- recovery success rate;
- calibration error and false confidence;
- unsafe replay count;
- reconciliation delay;
- extra latency, CPU, memory, and state growth;
- approval burden.

### Exit criteria

- at least 10,000 representative shadow decisions across diverse non-benchmark tasks;
- zero authority expansion or unsafe replay attributable to the packages;
- statistically defensible improvement on verified outcomes;
- deterministic restart with identical plan/adaptive state digests;
- immediate rollback to the prior planner snapshot.

## R3 — Developer Workstation OS

Time horizon: 2–8 months

Goal: convert Mecord from a powerful collection of runtime subsystems into one coherent developer product.

### R3.1 Workspace Graph

Create a typed graph connecting:

- workspace, repository, worktree, branch, commit, and dirty changes;
- files, symbols, definitions, references, diagnostics, tests, and ownership;
- terminals, processes, servers, ports, containers, and databases;
- browser tabs, app windows, UI elements, and screenshots;
- tasks, plans, approvals, evidence, artifacts, checkpoints, and user intent.

This should be a developer-domain projection over the existing world/perception/evidence stores, not a competing world model.

### R3.2 Developer Session

Make the durable user-facing unit an objective-bound session containing:

- acceptance criteria and constraints;
- workspace graph root;
- plan and plan history;
- tasks, workers, and resources;
- edits, diffs, tests, artifacts, and evidence;
- approvals and policy decisions;
- checkpoints, rollback, and recovery state;
- concise resumable summary.

### R3.3 Code intelligence

- fast content/regex search;
- LSP definitions, references, symbols, diagnostics, and call hierarchy;
- syntax-tree structural search and edits;
- dependency and impact analysis;
- test selection based on changed symbols and ownership;
- semantic merge/conflict assistance;
- bounded repository indexing with privacy and freshness controls.

### R3.4 Transactional editing

- multi-file edit plans;
- stale-content and symbol preconditions;
- previewable diff and impact estimate;
- atomic apply where possible;
- formatting/import organization;
- build/test/verification graph;
- rollback and evidence receipt.

### R3.5 Hermetic execution environments

- isolated worktrees;
- per-session process/port ownership;
- disposable containers or VMs where needed;
- dependency/cache policy;
- deterministic environment manifests;
- cleanup and reconciliation after crashes.

### R3.6 Artifact and Evidence Pack system

Use content-addressed artifacts for patches, builds, test reports, logs, screenshots, SBOMs, deployment receipts, and review summaries. Evidence Packs should be exportable, privacy-filtered, tamper-evident, and independently verifiable.

### Exit criteria

- one objective can be paused and resumed across reboot without lost context;
- a multi-file refactor can be previewed, applied, formatted, tested, verified, and rolled back;
- the system explains which repo, process, browser, tests, and artifacts belong to the session;
- another agent can review the Evidence Pack without trusting the executing agent's prose.

## R4 — Human-Centered Mecord Product

Time horizon: 3–9 months

Goal: make the power understandable and usable without internal knowledge.

### Control Center redesign

Replace the embedded one-line UI with a real, separately built, accessible frontend.

Core views:

- Home: device health, active sessions, blockers, and required actions;
- Session: objective, plan, progress, changes, tests, evidence, and rollback;
- Approval Center: plain-language scope, risk, reversibility, and alternatives;
- Activity: causally correlated intent-to-verification timeline;
- Devices: pairing, capabilities, trust, health, and updates;
- Policies: safe presets plus advanced policy detail;
- Knowledge: procedures, world facts, confidence, provenance, and invalidation;
- Diagnostics: redacted support bundle and repair guidance.

### Onboarding

```text
install -> doctor -> authenticate -> pair -> choose roots
-> test read -> test approval -> run guided task -> inspect proof
```

### Experience principles

- outcomes before internals;
- progressive disclosure;
- no raw UUIDs as primary UI;
- explain why an action is blocked;
- show whether a failure is retryable, reconcilable, reversible, or terminal;
- visualize plan changes and preserved successful work;
- make emergency stop and recovery obvious;
- never hide uncertainty behind green status.

### Exit criteria

- first verified task in under ten minutes for a prepared user;
- 80%+ guided onboarding completion;
- approval decisions understandable without documentation;
- at least ten external users complete primary workflows without developer assistance;
- support bundle diagnoses common failures without exposing credentials.

## R5 — Production Trust Platform

Time horizon: 4–12 months

Goal: make Mecord operable as a dependable platform rather than one carefully managed instance.

### R5.1 Observability

Add OpenTelemetry-compatible traces, metrics, and logs across:

- MCP request;
- account/device routing;
- relay queue and delivery;
- local task/plan/node/action;
- policy and approval;
- resource lease;
- provider execution;
- reconciliation;
- verification and artifact publication.

Privacy-safe correlation must preserve causal lineage without leaking payloads.

### R5.2 Service-level objectives

Track:

- control-plane availability;
- device online/reconnect rate;
- dispatch and verification latency;
- queue depth and delivery age;
- verified task completion;
- false completion;
- uncertain mutation and reconciliation time;
- crash-free sessions;
- update success/rollback;
- state growth and retention compliance.

### R5.3 Storage architecture

Define store interfaces with transaction, CAS, lease, retention, migration, snapshot, and restore semantics.

Recommended backend split:

- local device authority: embedded transactional database where useful, with OS-protected identity material;
- hosted control plane: PostgreSQL for accounts/devices/routing/delivery metadata;
- ephemeral coordination: only add Redis or equivalent when a measured multi-instance need exists;
- artifacts: object storage with content digests and retention;
- audit: append-only tamper-evident log with export/anchoring options.

Migrate store-by-store using shadow reads and consistency comparison. Avoid a big-bang rewrite.

### R5.4 Multi-instance relay

- stateless frontends where possible;
- durable shared delivery state;
- session ownership and handoff;
- fencing tokens for split-brain prevention;
- idempotent result processing;
- regional routing and failover;
- backpressure and admission control.

### R5.5 Reliability program

Continuously run:

- 24/72-hour soak tests;
- kill-at-every-transition fault injection;
- network partition/reordering/duplication;
- device sleep/reboot/clock drift;
- disk-full, permission, and corruption scenarios;
- 10k/100k/1M event growth;
- backup during mutation and verified restore;
- relay failover and duplicate worker scenarios.

### R5.6 Update platform

- stable, beta, and canary channels;
- signed manifests and payloads;
- staged deployment and automatic health halt;
- rollback and schema compatibility;
- transparent source/package/provenance display;
- offline verification.

### Exit criteria

- two or more relay instances safely share production state;
- every user-visible operation has an end-to-end trace;
- recovery objectives are measured and met;
- canary update can halt and roll back automatically;
- restore drills prove coherent state, not merely readable backup files.

## R6 — Universal Agent Gateway and Ecosystem

Time horizon: 6–18 months

Goal: allow many agent ecosystems and capability providers to use the same trusted runtime.

### Transport-neutral domain model

Canonical concepts:

```text
principal -> delegation -> intent -> goal -> plan -> node
-> authority envelope -> action -> resource -> evidence -> outcome
```

Adapters translate MCP, OpenAI agent paths, automation systems, enterprise agents, and local SDKs into these contracts. No adapter bypasses policy or verification.

### Supported SDKs

- TypeScript client and capability SDK;
- Python client and capability SDK;
- OpenAPI/JSON Schema or equivalent generated contracts;
- webhook/event subscription SDK;
- local simulator;
- conformance and adversarial test kit;
- compatibility matrix.

### Capability certification pipeline

```text
scaffold -> declare effects/authority/resources -> sandbox
-> contract tests -> adversarial tests -> performance tests
-> human/policy review -> sign -> publish -> monitor -> revoke
```

### Ecosystem governance

- signed capability packages;
- publisher identity;
- permission/effect manifest;
- reproducible build metadata;
- version and deprecation policy;
- vulnerability/revocation channel;
- verified compatibility badges;
- quality/reliability metrics based on observed receipts, not ratings alone.

### Document and data capabilities

Add bounded adapters for PDF, DOCX, XLSX/CSV, images, presentations, and structured data. Begin with inspect/extract/render, then add previewable edits, format-preserving output, independent rendering, and original-file recovery.

### Exit criteria

- a third party can implement a capability without changing core runtime code;
- conformance tests prove authority/effect declarations;
- an unsafe or compromised provider can be centrally revoked;
- at least three external agent/client integrations use identical trust semantics.

## R7 — Enterprise Agent Control Plane

Time horizon: 9–24 months

Goal: govern agents, humans, devices, projects, and evidence across an organization.

### Identity and delegation graph

- human, service, agent, subagent, workflow, and device principals;
- organization/project/environment hierarchy;
- attenuation-only delegation;
- purpose-bound leases;
- just-in-time elevation;
- expiry, revocation, and emergency organization halt;
- explainable authority path for every action.

### Enterprise administration

- SSO, SCIM, and role mapping;
- policy-as-code bundles;
- staged policy rollout and simulation;
- fleet inventory and posture;
- device trust and update compliance;
- private relay/VPC/on-prem deployment;
- audit export, retention, legal hold, and regional controls;
- usage, quotas, budgets, and chargeback;
- support/SLA operations.

### Policy language

The policy engine should express:

- principal and delegation requirements;
- capability, effect, and risk constraints;
- resource labels and environments;
- time, location, device posture, and session conditions;
- approval quorum and separation of duties;
- evidence and verifier requirements;
- cost and resource ceilings;
- retention and publication policy.

Provide simulation: “Would this policy allow the last 10,000 actions, and where would behavior change?”

### Exit criteria

- a large organization can answer who/what/why/where for every agent mutation;
- policy changes can be simulated before enforcement;
- high-risk actions support separation of duties;
- private deployment and audit export are independently tested.

## R8 — Counterfactual Twin and Proof Kernel

Time horizon: 12–30 months

Goal: discover consequences before real mutation and distinguish proof from inference.

### Counterfactual digital twin

Construct a truthful, scoped twin from:

- repository/worktree snapshot;
- dependency lockfiles and environment manifest;
- containers/services/database fixtures;
- browser/app state where reproducible;
- policy/authority envelope;
- selected world facts with provenance.

Use it to compare alternative plans, run tests, estimate blast radius, and identify conflicts. The twin must declare fidelity limits; it cannot claim safety for resources it did not model.

### Proof vocabulary

Every important claim should be classified:

- `PROVEN`: derived from deterministic trusted rules or exact structural proof;
- `EMPIRICALLY_VERIFIED`: observed through independent tests/probes;
- `CORROBORATED`: supported by multiple independent evidence sources;
- `INFERRED`: plausible but not independently established;
- `UNKNOWN`: insufficient evidence;
- `CONTRADICTED`: evidence refutes the claim.

### Proof kernel inputs

- policy evaluation;
- static analysis and type systems;
- dependency and route graphs;
- configuration invariants;
- test and runtime probes;
- before/after structural comparisons;
- cryptographic identities and receipts;
- independent verifier results.

### Proof-carrying execution

High-value operations should produce a bundle containing:

- exact goal/constraints;
- authority and approval proof;
- plan and decision lineage;
- preconditions and observed state;
- action/effect journal;
- verification evidence;
- residual uncertainty;
- rollback/recovery status.

### Exit criteria

- the system refuses to label inferred properties as proven;
- twin fidelity and missing dimensions are explicit;
- selected deployment/security/refactor workflows demonstrate fewer real-world failures than direct execution;
- proof bundles are machine-verifiable outside the executing runtime.

## R9 — Distributed Autonomous Engineering Fabric

Time horizon: 18–36 months

Goal: safely coordinate complex engineering work across heterogeneous devices and specialized agents.

### Scheduler

Place work according to:

- authority and data locality;
- OS/tool/hardware requirements;
- security class and device posture;
- CPU/RAM/GPU/process/port capacity;
- latency and cost;
- artifact availability;
- isolation requirements;
- trust and reliability history.

### Worker roles

- investigation and reproduction;
- code change;
- tests and fuzzing;
- browser/native UI validation;
- performance and compatibility;
- independent verification;
- packaging/signing/release;
- incident recovery.

### Isolation

- disposable workspaces/VMs/containers;
- resource ownership and fencing;
- network/data policies;
- artifact-only exchange where appropriate;
- deterministic conflict detection;
- supervised handoff and reconciliation.

### Economic/resource optimization

Optimize only inside authority and quality constraints:

- choose appropriate model/worker/provider;
- allocate compute budgets;
- cache safe reproducible work;
- stop low-value branches;
- trade latency/cost only after hard safety and verification requirements.

### Exit criteria

- one objective runs across multiple machines without weakened identity or authority;
- duplicate/split-brain work is fenced;
- artifacts and evidence remain causally linked;
- measured verified completion improves materially over single-agent direct execution.

## R10 — Verifiable Autonomous Engineering OS

Time horizon: 24–48 months

Goal: integrate the complete system into a continuously improving but bounded engineering operating layer.

Target loop:

```text
Human/organization objective
          |
          v
Goal + constraint compiler
          |
          v
Authority/delegation/lease compiler
          |
          v
Workspace Graph + causal memory
          |
          v
Verified planning + counterfactual twin
          |
          v
Proof/risk gate
          |
          v
Distributed isolated execution
          |
          v
Independent verification + Evidence Pack
          |
          v
Human review / certified outcome
          |
          v
Receipt-gated adaptive learning
```

This release is accepted only when the integrated system demonstrates:

- materially higher verified success than direct agent/tool access;
- materially lower false completion and human babysitting;
- reliable interruption/recovery;
- zero demonstrated authority violations in certified suites;
- transparent uncertainty and failure;
- portable proof of results;
- safe rollback and policy-controlled learning.

## 7. Detailed initiative catalog

| ID | Initiative | Priority | Depends on | Approximate effort |
|---|---|---:|---|---:|
| FND-01 | Canonical branch/workspace and clone archival | P0 | Deep-audit inventory | 1 week |
| FND-02 | Generated release truth ledger | P0 | Canonical branch | 1 week |
| FND-03 | Root workspaces and strict TypeScript projects | P0 | Canonical branch | 2–4 weeks |
| FND-04 | Contract/schema registry and compatibility suite | P0 | Type system | 2–3 weeks |
| FND-05 | Orchestrator/server/browser modularization | P0 | Characterization tests | 3–6 weeks |
| FND-06 | CI lane rationalization | P1 | Workspace scripts | 1–2 weeks |
| INT-01 | Canonical execution identity graph | P0 | Contract registry | 2–3 weeks |
| INT-02 | Shadow decision/outcome envelope | P0 | Identity graph | 1–2 weeks |
| INT-03 | Adaptive/core epistemic adapter | P0 | Shadow envelope | 2–3 weeks |
| INT-04 | Plan/task/team graph convergence | P0 | Identity graph | 3–5 weeks |
| INT-05 | Shadow store, retention, privacy, replay | P0 | Persistent catalog | 2–3 weeks |
| INT-06 | Evaluation cohorts and promotion dashboard | P1 | Shadow telemetry | 2–4 weeks |
| INT-07 | Advisory and reversible canary control | P1 | Promotion evidence | 4–8 weeks |
| DEV-01 | Workspace Graph | P1 | Contract registry | 4–8 weeks |
| DEV-02 | Developer Session | P1 | Workspace Graph | 3–5 weeks |
| DEV-03 | Search and LSP intelligence | P1 | Workspace Graph | 4–8 weeks |
| DEV-04 | Transactional structural editing | P1 | LSP + artifacts | 4–8 weeks |
| DEV-05 | Hermetic worktree/process/port environments | P1 | Session/resource model | 4–6 weeks |
| DEV-06 | Artifact and Evidence Pack service | P1 | Identity/contracts | 3–5 weeks |
| UX-01 | Real Control Center frontend | P1 | Stable local API | 6–10 weeks |
| UX-02 | Guided onboarding and doctor | P1 | Release truth + diagnostics | 2–4 weeks |
| UX-03 | Approval/recovery experience | P1 | Identity + evidence | 2–4 weeks |
| OPS-01 | OpenTelemetry correlation | P1 | Canonical identities | 3–5 weeks |
| OPS-02 | SLOs, alerts, and dashboards | P1 | Telemetry | 2–4 weeks |
| OPS-03 | Store abstraction and embedded transactions | P1 | Contracts/migrations | 4–8 weeks |
| OPS-04 | PostgreSQL hosted control plane | P2 | Store abstraction | 6–12 weeks |
| OPS-05 | Multi-instance relay and fencing | P2 | Shared database | 6–10 weeks |
| OPS-06 | Continuous soak/fault laboratory | P1 | Telemetry | 3–6 weeks |
| OPS-07 | Signed staged updater and rollback | P1 | Release ledger | 4–8 weeks |
| ECO-01 | TypeScript/Python client SDKs | P2 | Stable contracts | 4–8 weeks |
| ECO-02 | Capability conformance/certification kit | P2 | SDK + sandbox | 4–8 weeks |
| ECO-03 | Signed capability registry | P2 | Certification kit | 8–16 weeks |
| ECO-04 | Document/data adapters | P2 | Artifact/render system | 8–16 weeks |
| ENT-01 | Principal/delegation graph | P2 | Identity graph | 6–10 weeks |
| ENT-02 | Purpose-bound authority leases | P2 | Delegation graph | 4–8 weeks |
| ENT-03 | Policy language and simulation | P2 | Enterprise identity | 8–16 weeks |
| ENT-04 | Fleet/admin/private deployment | P2 | Scalable control plane | 12–24 weeks |
| FUT-01 | Counterfactual digital twin | P3 | Workspace Graph + hermetic env | 12–24 weeks |
| FUT-02 | Unified proof kernel/vocabulary | P3 | Evidence Packs | 10–20 weeks |
| FUT-03 | Causal engineering memory | P2 | Workspace Graph + adaptive core | 8–16 weeks |
| FUT-04 | Distributed compute mesh | P3 | Multi-instance/fleet | 16–32 weeks |
| FUT-05 | Dynamic capability synthesis | P3 | Certification pipeline | 16–32 weeks |
| FUT-06 | Public certification network | P3 | Evaluation + Evidence Packs | 12–24 weeks |

Effort ranges describe engineering work, not calendar promises. Product discovery, external review, platform certification, and user feedback can dominate elapsed time.

## 8. The exact next 180 days

### Month 1 — Converge

- finish and ingest validated deep-audit results;
- freeze and document canonical source/release identities;
- complete concurrent feature integration only through adapters and shadow boundaries;
- add strict type checking to new packages and contracts;
- create decision records for identity, plan convergence, storage, artifacts, and Workspace Graph;
- prevent further direct growth of the largest monoliths.

### Month 2 — Observe

- deploy shadow decision/outcome telemetry locally;
- run adaptive intelligence and verified planning observation-only;
- build frozen evaluation cohorts;
- start orchestrator/server extraction;
- restructure CI and publish flake/timing metrics;
- design the new Control Center and Workspace Graph APIs.

### Month 3 — Build the product spine

- ship Workspace Graph v1;
- ship Developer Session v1;
- create Artifact/Evidence Pack v1;
- add search and TypeScript LSP integration;
- build the new Control Center shell and onboarding/doctor;
- instrument end-to-end traces.

### Month 4 — Prove intelligence

- collect and analyze at least 10,000 shadow decisions;
- calibrate progress/failure/recovery predictions;
- allow advisory observation requests only if evidence supports them;
- add transactional multi-file edit preview;
- run 24-hour soak and fault campaigns;
- start storage-interface extraction.

### Month 5 — Canary

- enable read-only plan-node ranking for an opt-in canary;
- enable reversible low-risk action ordering only after promotion gates pass;
- complete approval, recovery, and activity UX;
- add staged updater/canary/rollback;
- begin embedded transactional store migration for the highest-contention local state.

### Month 6 — Release candidate

- run full qualification, red-team, fault, performance, packaging, upgrade, and rollback certification;
- conduct external-user onboarding and primary-journey studies;
- publish verified metrics comparing old and new planners;
- decide whether to promote general planning control, remain in canary, or roll back;
- produce a single Evidence Pack for the release itself.

## 9. “God-level” research directions

These are research programs, not near-term product promises.

### 9.1 Proof-carrying agents

Require an agent to supply machine-checkable preconditions, predicted effects, verification plans, and authority references with its proposed action. The runtime accepts only proposals that satisfy deterministic validation.

### 9.2 Causal intervention learning

Learn which action caused which state transition using controlled interventions, independent evidence, and counterfactual comparison—not mere trajectory correlation.

### 9.3 Verified skill distillation

Convert repeated successful, independently verified plans into parameterized skills with explicit assumptions, effect models, authority needs, failure modes, and invalidation triggers.

### 9.4 Runtime model portfolios

Use different models for planning, visual grounding, code analysis, critique, and verification, selected through bounded evidence-based routing. No model's confidence is authority.

### 9.5 Confidential execution

For enterprise/private workloads, explore hardware-backed attestation, confidential VMs, customer-held encryption keys, and proof that only approved runtime revisions accessed protected data.

### 9.6 Privacy-preserving learning

Aggregate reliability and strategy signals without centralizing raw customer content. Consider local aggregation, differential privacy, or federated updates only when correctness and poisoning defenses are demonstrable.

### 9.7 Mechanized invariant verification

Model critical protocols—delegation, leases, uncertain mutation, reconciliation, and plan revision—in TLA+, PlusCal, Alloy, or equivalent tools. Use model-checking counterexamples to generate regression tests.

### 9.8 Autonomous incident command

Coordinate detection, containment, diagnosis, repair, validation, and recovery across infrastructure while enforcing blast-radius limits, separation of duties, and human escalation.

### 9.9 Semantic hardware and physical-world adapters

Long-term, the same authority/evidence model could govern lab devices, robots, or industrial systems. This should happen only with domain-specific safety cases and independent hardware interlocks.

### 9.10 Agent reliability certification standard

Develop a portable specification for verified task success, authority compliance, recovery, evidence completeness, and false-completion measurement that can compare agents under identical execution conditions.

## 10. Risk register

| Risk | Why it matters | Required mitigation |
|---|---|---|
| Planner split-brain | Existing and new planners can disagree over state/ownership | One canonical plan identity; adapters; staged promotion |
| Epistemic duplication | World, perception, core, and adaptive state may conflict | Explicit source hierarchy and reconciliation vocabulary |
| Authority leakage through planning | High-level decisions may hide wider effects | Exact action authorization remains below planner |
| State explosion | Plans, traces, evidence, world facts, and artifacts grow indefinitely | Retention classes, compaction, snapshots, content addressing |
| Telemetry privacy | Shadow data may capture sensitive context | Bounded schemas, digests, redaction, sampling, local-first storage |
| Benchmark overfitting | Apparent intelligence gains may not generalize | Frozen cohorts, hidden tasks, real-user evaluation, no promotion from benchmark alone |
| Monolith regression | Direct integration into large files amplifies risk | Module extraction and contract boundaries first |
| Source/release drift | Wrong code may be packaged or deployed | Generated release ledger and immutable provenance |
| Single-node control plane | File ownership prevents reliable scale/failover | Store abstraction, shared transactions, fencing |
| Product incomprehensibility | Powerful internals remain unusable | Outcome-oriented Control Center and guided onboarding |
| Certification fatigue | Huge CI creates slow feedback and ignored failures | Layered CI, ownership, trends, affected tests |
| Premature platform expansion | macOS/Linux breadth can dilute Windows quality | Demand gate and provider-contract reuse |
| Self-healing overreach | Recovery can repeat uncertain destructive work | Reconciliation and hard runtime veto |
| Learned-policy poisoning | Bad outcomes can corrupt behavior | Receipt-gated promotion, shadow comparison, rollback |
| Marketing overclaim | Stage count can be mistaken for maturity | User/outcome/SLO metrics and externally reproducible evidence |

## 11. Governance for concurrent work

Because integration and auditing are happening concurrently, apply these rules immediately:

1. One integration owner controls edits to `TaskOrchestrator`, runtime construction, and persistent schemas.
2. Feature packages remain isolated and independently qualifying until adapter contracts are merged.
3. The deep-audit branch never receives feature work; the integration branch never silently absorbs unreviewed audit patches.
4. Every cross-branch transfer records source SHA, tests, and expected invariant impact.
5. Do not rebase or force-push branches containing evidence used for certification.
6. Uncommitted work is checkpointed before another workstream modifies the same file.
7. A merge train orders: security/correctness fixes -> contract foundation -> shadow integration -> product features.
8. Full certification runs on an immutable release candidate, not a moving integration folder.

## 12. What should not be built yet

- another numbered stage collection;
- a new model or generic coding-agent brain;
- broad autonomous control before shadow evidence;
- a second world model or second verification authority;
- a marketplace before the capability certification pipeline;
- multi-region scale before store semantics and SLOs exist;
- automatic capability synthesis before sandboxing and signing exist;
- macOS/Linux advanced GUI parity before product demand and test ownership;
- opaque “trust scores” based on model self-report;
- blockchain or distributed ledger machinery without a concrete trust requirement;
- an unrestricted shell/computer primitive disguised as a high-level tool.

## 13. Definition of “god-level”

Mecord is not god-level because it has many tools, stages, agents, or tests.

It reaches that level only when it can repeatedly demonstrate all of the following:

- understands a bounded objective and its hard constraints;
- knows what it knows, what it does not know, and what is contradicted;
- constructs and repairs a plan without rewriting history;
- uses the least-authoritative and most deterministic mechanism available;
- survives crashes, disconnections, stale state, and worker failure;
- never replays an uncertain mutation blindly;
- verifies outcomes independently;
- explains every action and decision to a human;
- produces portable proof;
- improves through verified experience without learning unsafe authority;
- scales from one computer to a governed fleet;
- works with multiple agent/model vendors through the same trust boundary;
- fails closed, honestly, and recoverably.

That is the real long-term product: not an agent that claims autonomy, but an operating system that makes autonomy trustworthy.

## 14. Immediate decision

The next program should be called:

> **Mecord Convergence Program — Trusted Runtime to Developer Workstation OS**

The first release train should contain only:

1. canonical source/release truth;
2. deep-audit closure;
3. repository-wide type/contract foundation;
4. shadow integration of Adaptive Intelligence and Verified Plan Runtime;
5. orchestrator/server modularization;
6. Workspace Graph and Developer Session foundations;
7. Artifact/Evidence Pack v1;
8. new Control Center shell and end-to-end observability.

Everything else in this blueprint should be pulled only after those foundations produce measurable user and trust outcomes.
