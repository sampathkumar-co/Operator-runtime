# R7 Independent Enterprise Acceptance Campaign

R7 repository implementation is already certified. This protocol defines the remaining organization-level acceptance evidence.

## Required organization exercise

The campaign must use an external identity provider and exercise the same organization across real policy/admin flows:

- SSO identity resolution;
- SCIM provision;
- role mapping;
- SCIM deactivation;
- JIT purpose-bound authority issue/expiry/revocation;
- approval quorum;
- separation of duties;
- managed-device posture enforcement;
- quotas and budgets.

## Mutation explainability

Exercise at least 100 governed mutations. Every mutation must have complete who / what / why / where explanation coverage. Anything below 100% fails certification.

## Policy simulation

Replay a proposed policy against at least 100 historical actions and retain evidence of the resulting allow/deny deltas.

## Private deployment

The deployment must be either private VPC or on-prem. An independent verifier must prove:

- public ingress is denied;
- control-plane access stays private;
- the independent network/deployment probe passes.

At least two content-addressed evidence artifacts are required.

## Audit acceptance

An independent verifier must validate:

- the audit export digest;
- legal-hold behavior;
- regional controls;
- chargeback output.

The verifier identity must be different from the operating principal.

## Evidence safety

Store only bounded identifiers and SHA-256 evidence digests in the campaign file. Do not store IdP credentials, bearer tokens, signing keys, private network credentials, or personal user data.

Evaluate with:

```bash
node --experimental-strip-types scripts/evaluate-r7-enterprise-acceptance.ts certification/r7/campaign.json
```

Synthetic tests validate the evaluator only. They do not satisfy program-level R7 acceptance.
