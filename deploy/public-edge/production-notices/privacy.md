# Mecord Connect Privacy Notice

Effective: 17 September 2026

Mecord Connect is operated by the publisher of splcart.in. Privacy and support requests may be sent to support@splcart.in.

## What the service processes

Operator processes the identity information needed to authenticate you, device enrollment and routing metadata, task instructions, and the minimum computer data required to perform an action you explicitly request on a paired device. OAuth access tokens are verified for authorization and are not intended to be stored as application data.

The paired local runtime remains the execution boundary. Local policy, authorized roots, capability permissions, emergency-stop state, and approval requirements are checked on the paired computer before an action is executed.

## Hosted infrastructure

The production service at operator.splcart.in and auth.splcart.in currently runs on Hostinger infrastructure; the production IP is announced by AS47583 and is geolocated to Cyprus. Authentication is provided by a self-hosted Authelia instance on the same Operator infrastructure. Authentication notification email transport may use ImprovMX infrastructure.

## Retention

Acknowledged relay delivery payloads are erased immediately. Pending relay delivery payloads and returned relay results expire after 24 hours by default and are pruned or reduced to payload-free terminal records as applicable. Device-enrollment records are short-lived and normally retained no more than 24 hours after their terminal state. Completed erasure tombstones are retained for 24 hours. Authentication sessions are configured with a 30-minute expiration and a 5-minute inactivity window.

Operational container logs are size-rotated and are used for reliability and security diagnostics. They are not intended to contain OAuth bearer tokens, device private keys, relay-control secrets, or file contents.

## Sharing and security

Operator does not sell personal data. Data is disclosed only as needed to operate the service, comply with law, protect the service or users, or use the infrastructure described above. Operator uses TLS at the public edge, scoped OAuth authorization, signed device identity, bounded relay authority, local approvals and capability checks, and restricted public result projection. No system can guarantee absolute security.

## Your choices and requests

You can stop the local Operator runtime, revoke or reset a paired device, or request account/device erasure. For access, correction, deletion, privacy questions, or a private security report, email support@splcart.in. For a security report, use the subject "Mecord Connect Security Report" and do not send passwords, private keys, access tokens, or other live credentials.

Mandatory privacy and consumer rights that apply to you remain unaffected by this notice.
