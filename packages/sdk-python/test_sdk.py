import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from mecord_sdk import (
    CapabilityManifest,
    CapabilityManifestEntry,
    GatewayProposal,
    sign_webhook_body,
    verify_webhook_signature,
)


class SdkTests(unittest.TestCase):
    def test_manifest_validation_and_gateway_proposal(self):
        entry = CapabilityManifestEntry(
            capability="file.read",
            risk="read",
            deterministic=True,
            reversible=True,
            verification="runtime",
            reconciliation="not-required",
            inputSchemaVersion=1,
            inputMaxBytes=4096,
            outputMaxBytes=4096,
            cancellation="required",
            resourceKinds=["file"],
        )
        manifest = CapabilityManifest(
            id="example.files",
            version="1.0.0",
            displayName="Example Files",
            provenance={"source": "test", "packageDigest": "a" * 64},
            capabilities=[entry],
        )
        self.assertEqual(manifest.validate()["id"], "example.files")
        proposal = GatewayProposal.create(
            transport="local-sdk",
            principal_id="local-user",
            execution_context={"schemaVersion": 1, "actionId": "a"},
            action={"id": "a", "capability": "file.read", "risk": "read", "input": {}, "provenance": {"kind": "runtime"}},
            adapter_version="1.0.0",
        )
        self.assertEqual(proposal.schemaVersion, 1)

    def test_webhook_signature_is_tamper_evident(self):
        secret = "s" * 32
        signature = sign_webhook_body('{"ok":true}', secret)
        self.assertTrue(verify_webhook_signature('{"ok":true}', signature, secret))
        self.assertFalse(verify_webhook_signature('{"ok":false}', signature, secret))


if __name__ == "__main__":
    unittest.main()
