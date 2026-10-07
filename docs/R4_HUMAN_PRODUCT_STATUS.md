# R4 — Human-Centered Mecord Product

Status: **IMPLEMENTED — repository-owned R4 product surface complete; external usability evidence still required for final maturity certification**

Baseline: `main` at `43f57735808d392b6572783d2a4bdcd8a70819b3`.

## Implemented

- separately served Control Center HTML/CSS/JavaScript instead of the previous embedded one-line application;
- accessible navigation and keyboard/focus semantics for Home, Sessions, Approval Center, Activity, Devices, Policies, Knowledge, and Diagnostics;
- runtime-backed Home health/task/approval projection;
- Approval Center semantics for expiry, risk, effect class, reversibility, approve/deny eligibility, and in-use state;
- Recovery Center semantics that refuse unsafe automatic retry under uncertain effects;
- guided onboarding state machine plus safe read probe and harmless approval practice;
- durable, privacy-bounded experience events for onboarding timing/completion measurement;
- redacted support bundle with repair guidance that excludes agent/recovery tokens and authorized-root paths;
- packaged-runtime closure for the standalone Control Center assets;
- dedicated R4 Linux/Windows CI lane and local HTTP/API contract tests.

## Preserved trust boundaries

The Control Center does not grant authority. All data APIs still require the existing bearer token. Approval mutations still require the separate recovery token. The shell and static assets are credential-free. Recovery recommendations do not execute actions. Uncertain mutation remains reconciliation-first.

## Certification boundary

Repository-owned implementation can be certified by CI. The blueprint's human outcome criteria — first verified task under ten minutes, at least 80% guided-onboarding completion, understandable approval decisions, and ten external users completing primary workflows without developer assistance — require real user-study evidence and must not be fabricated from automated tests.

The Control Center now records bounded `control-center.experience` audit events so those metrics can be collected honestly.
