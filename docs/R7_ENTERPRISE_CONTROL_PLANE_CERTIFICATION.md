# R7 Enterprise Agent Control Plane Certification

Status: **CERTIFIED**

R7 is certified for subject SHA `d05b386b7c9c26b2e092041e54e02b3dc83ba248`. Repository implementation is qualified by `.github/workflows/r7-enterprise-control-plane.yml`; independent enterprise campaign `r7-enterprise-20261008004902` passed the committed evaluator. Its content-addressed manifest is at `certification/r7/evidence/r7-enterprise-20261008004902/manifest.json`, and its evaluator report is at `artifacts/r7-enterprise-acceptance/report.json`.

## Work-package coverage

- **R7-ENT-01 Principal/delegation graph** — humans, services, agents, subagents, workflows, devices, organizations, projects and environments; acyclic, attenuation-only delegation.
- **R7-ENT-02 Purpose-bound authority leases** — bounded JIT leases, exact purpose/revision binding, child attenuation, expiry, revocation and emergency halt.
- **R7-ENT-03 Enterprise identity** — trusted provider configuration, verified-claim-only SSO resolution, SCIM provisioning/deactivation and role/group mapping.
- **R7-ENT-04 Policy language** — principal/delegation, capability/risk/resource/environment, posture, time/location/session, quorum, separation of duties, verifier/evidence, cost, retention and publication constraints.
- **R7-ENT-05 Policy simulation** — replay proposed policy against historical actions and report changed allow/deny outcomes.
- **R7-ENT-06 Fleet/admin** — inventory/posture, update channel, private VPC/on-prem proof, regional controls, quotas, budgets, chargeback, legal hold and content-addressed audit export.

## Exit-gate proof

The R7 suite requires that an organization can:

1. explain **who / what / why / where** for a mutation;
2. simulate a policy before enforcement against historical actions;
3. prove a private deployment is actually private-VPC or on-prem;
4. export a bounded, digest-bound audit package under legal-hold policy.

No R7 policy or identity object grants authority by itself: effective execution remains bounded by the existing local/runtime authority and lease boundary.

## Independent enterprise acceptance

The campaign ran WSO2 Identity Server 7.1.0 as a separately implemented identity provider on an internal-only on-prem Docker network with no published ports. It proved SCIM provision/group-role/deactivation, cryptographically verified OIDC identity resolution, JIT lease issue/expiry/revocation, quorum and separation of duties, managed posture, quota/budget denial, 100 governed mutations with complete who/what/why/where explanations, and 100 historical policy replays.

A separate hardened verifier container independently rehashed every evidence artifact, probed the private identity/control-plane network, recomputed the audit digest, and verified legal hold, regional controls, and chargeback output. The verifier reported `VERIFIED`; the repository evaluator reported `CERTIFIED` with report digest `7d7936068dd1b7fe9204327f08d3a58a740f50445b47762ee42e57dd95fda9bb`. No identity-provider credential, OAuth token, or signing secret was persisted.
