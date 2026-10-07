import unittest
from mecord_sdk import build_gateway_proposal, TrustedAgentGatewayClient, MecordSdkError

class GatewayTests(unittest.TestCase):
    def test_digest_matches_typescript_fixture(self):
        proposal=build_gateway_proposal(
            transport="local-sdk",
            principal_id="agent:python",
            adapter_version="1.0.0",
            action={"id":"python-read","capability":"file.read","risk":"read","input":{"path":"/tmp/example"},"provenance":{"kind":"chatgpt"}},
            execution_context={"schemaVersion":1,"actionId":"python-read"},
            proposed_at="2026-10-07T00:00:00.000Z",
        )
        self.assertEqual(proposal["digest"],"4ab82263f99a2eab12b56f436a613fe3d9569fc5cb3d65f00ed62e54bcbebb67")

    def test_receipt_must_bind_exact_proposal(self):
        client=TrustedAgentGatewayClient("local-sdk","agent:python","1.0.0",lambda:"2026-10-07T00:00:00.000Z")
        action={"id":"python-read","capability":"file.read","risk":"read","input":{"path":"/tmp/example"},"provenance":{"kind":"chatgpt"}}
        with self.assertRaises(MecordSdkError):
            client.submit(action,lambda proposal:{"schemaVersion":1,"proposalDigest":"f"*64,"status":"ACCEPTED","receivedAt":"2026-10-07T00:00:01.000Z"})

if __name__=="__main__":
    unittest.main()
