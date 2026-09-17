# DRAFT — SPLCART Operator Runtime License

**Non-effective draft for owner/legal review. Do not ship as `LICENSE` until approved and all bracketed decisions are resolved.**

This Runtime License governs the `@mecrod/operator` software package and bundled runtime components (the "Software"). "Licensor" means the legal person or entity identified as the publisher in the final release materials. "You" means the individual or entity using the Software.

## 1. License grant

Subject to this License and the applicable SPLCART Operator service Terms, Licensor grants You a limited, non-exclusive, non-transferable, non-sublicensable license to download, install and execute the Software on computers You own or are authorized to control, solely to use supported SPLCART Operator functionality and authorized integrations.

You may make a reasonable number of backup copies solely for disaster recovery, provided all proprietary notices are preserved.

## 2. Authorized use

You are responsible for ensuring that every computer, account, project, file, service and dataset accessed through the Software is one You are legally authorized to access or control.

The Software is not licensed for unauthorized surveillance, credential theft, malware delivery, security-control bypass, unlawful access, impersonation, harmful automation, or other use prohibited by the service Terms or applicable law.

## 3. Restrictions

Except where applicable law does not permit a restriction, You may not:

- sell, rent, lease, sublicense, redistribute or commercially repackage the Software as a standalone product;
- provide the Software to third parties as part of a competing hosted remote-control, agent or automation service without Licensor's written permission;
- remove or alter copyright, license, security or provenance notices;
- bypass or intentionally disable authentication, device authority, local policy, approval, safety, usage-control or audit mechanisms;
- reverse engineer, decompile or disassemble the Software except to the limited extent such activity is expressly permitted by mandatory law;
- use Licensor trademarks, branding or service identity to imply sponsorship or endorsement without permission.

## 4. Ownership and source availability

The Software is licensed, not sold. Licensor and its licensors retain all right, title and interest in the Software except for the limited rights expressly granted here.

Public availability of source code does not, by itself, grant open-source rights or any rights beyond this License. Third-party components remain governed by their own licenses.

## 5. Service dependency and changes

Some Software functionality depends on the hosted SPLCART Operator service, authentication infrastructure, relay services, supported OpenAI integrations, and compatible platform software. Availability of those external or hosted components is governed separately and is not guaranteed by this Runtime License.

Licensor may provide updates, security fixes or replacement versions. Updates may be required to maintain compatibility or security. A future version may be offered under updated license terms, subject to applicable law.

## 6. Security and credentials

You must protect account credentials, pairing codes, local device state and any other authentication material associated with the Software. You must not intentionally expose or transfer device authority to an unauthorized person.

Security controls are designed to reduce risk but do not make automation error-free or suitable for unsupervised use in every environment. You remain responsible for reviewing high-impact actions and maintaining appropriate backups.

## 7. Privacy

Processing of personal data by the hosted SPLCART Operator service is governed by the applicable Privacy notice and service Terms. The Software may process local project/device information necessary to perform actions You request or authorize.

## 8. Feedback

If You voluntarily provide ideas or feedback about the Software, You grant Licensor a worldwide, perpetual, irrevocable, royalty-free right to use that feedback without obligation to You, provided this does not transfer ownership of Your confidential information or project content.

## 9. Termination

This License terminates automatically if You materially breach its terms and do not cure the breach where a cure period is required by applicable law. On termination, You must stop using and delete copies of the Software, except for archival copies You are legally required to retain.

Termination of this Runtime License does not by itself determine the status of a separate hosted-service account, and termination of the hosted service may make the Software unusable.

## 10. Disclaimer

TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ERROR-FREE OPERATION OR UNINTERRUPTED AVAILABILITY. NOTHING IN THIS SECTION EXCLUDES WARRANTIES THAT CANNOT LAWFULLY BE EXCLUDED.

## 11. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, LICENSOR WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE OR CONSEQUENTIAL DAMAGES, OR FOR LOSS OF PROFITS, REVENUE, DATA, GOODWILL OR BUSINESS OPPORTUNITY ARISING FROM THE SOFTWARE.

The final license must specify an appropriate aggregate liability cap and any legally required exceptions. **[OWNER/LEGAL TO SET LIABILITY CAP AND MANDATORY-LAW EXCEPTIONS.]**

## 12. Governing law and disputes

The final license must identify the actual Licensor legal identity, governing law, forum/dispute process and contact details. **[OWNER/LEGAL TO COMPLETE BEFORE PUBLICATION.]**

## 13. Entire agreement and precedence

This Runtime License governs rights in the Software itself. The hosted service Terms govern use of the SPLCART Operator service. If the final documents conflict, the final approved text must state which provision controls for the relevant subject matter.

## Publication checklist for this draft

Before converting this draft into the package-root `LICENSE`:

1. identify the actual Licensor legal person/entity and contact;
2. finalize governing law, dispute terms and liability cap;
3. review the permitted-use grant and restrictions against the intended business model;
4. reconcile this License with the live Terms and Privacy notice;
5. remove every bracketed placeholder and this draft warning;
6. set `package.json` to `"license": "SEE LICENSE IN LICENSE"`;
7. verify `npm pack --json` contains root `LICENSE`;
8. rerun all affected OCC-3N certification before publication.
