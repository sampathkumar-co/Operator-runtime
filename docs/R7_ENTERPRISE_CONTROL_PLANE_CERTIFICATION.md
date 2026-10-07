# R7 Enterprise Agent Control Plane Certification

Status: **REPOSITORY_IMPLEMENTATION_CERTIFIED**

R7 is qualified by the dedicated exact-head workflow `.github/workflows/r7-enterprise-control-plane.yml`. The generated artifact `artifacts/r7/certification.json` binds every certification run to its tested source SHA and file digests.

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
