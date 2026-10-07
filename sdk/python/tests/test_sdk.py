import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import unittest
from mecord_capability_sdk import create_extension_manifest, manifest_digest, create_conformance_plan

class SdkTest(unittest.TestCase):
    def manifest(self):
        return create_extension_manifest({"id":"acme.data","version":"1.0.0","displayName":"Acme Data","provenance":{"source":"https://example.invalid/data","packageDigest":"a"*64},"capabilities":[{"capability":"ext.acme.data.record.lookup","risk":"read","deterministic":True,"reversible":True,"verification":"runtime","reconciliation":"not-required","inputSchemaVersion":1,"inputMaxBytes":4096,"outputMaxBytes":4096,"cancellation":"required","resourceKinds":["record"]}]})
    def test_manifest_digest(self):
        m=self.manifest()
        self.assertEqual(len(manifest_digest(m)),64)
        self.assertEqual(create_conformance_plan(m)["requiredSuites"],["SANDBOX","CONTRACT","ADVERSARIAL","PERFORMANCE"])
    def test_namespace_required(self):
        m=self.manifest(); m["capabilities"][0]["capability"]="record.lookup"
        with self.assertRaises(ValueError): create_extension_manifest(m)

if __name__=="__main__": unittest.main()
