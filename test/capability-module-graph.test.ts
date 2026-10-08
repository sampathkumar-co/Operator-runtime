import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { capabilityManifestDigest, validateManifest } from '../src/core/capability-sdk.ts';
import { createCapabilityConformanceReceipt, certifyCapabilityExtension } from '../src/core/capability-conformance.ts';
import { signCapabilityPackage } from '../src/core/capability-package-registry.ts';
import { CapabilityGovernanceRegistry } from '../src/core/capability-governance.ts';
import { loadGovernedCapabilityModule } from '../src/core/capability-extension-loader.ts';
import { normalizeVerifiedModuleGraph, snapshotVerifiedModuleGraph, verifiedModuleGraphDigest } from '../src/core/verified-module-graph.ts';

const HAS_HOOKS = typeof (nodeModule as typeof nodeModule & { registerHooks?: unknown }).registerHooks === 'function';

function digest(bytes: string | Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function graphFor(contents: Record<string, string>) {
  return normalizeVerifiedModuleGraph({
    entry: 'provider.mjs',
    modules: Object.entries(contents).map(([name, bytes]) => ({ path: name, sha256: digest(bytes) }))
  });
}

function signedFixture(graph: ReturnType<typeof graphFor>) {
  const manifest = validateManifest({
    sdkVersion: 1, id: 'ext.graph.test', version: '1.0.0',
    displayName: 'Signed Graph Test',
    provenance: { source: 'file:provider.mjs', moduleGraph: graph, packageDigest: verifiedModuleGraphDigest(graph) },
    capabilities: [{
      capability: 'file.read', risk: 'read', deterministic: true, reversible: true,
      verification: 'runtime', reconciliation: 'not-required', inputSchemaVersion: 1,
      inputMaxBytes: 4096, outputMaxBytes: 4096, cancellation: 'required', resourceKinds: ['file']
    }]
  });
  const manifestDigest = capabilityManifestDigest(manifest);
  const receipts = (['SANDBOX', 'CONTRACT', 'ADVERSARIAL', 'PERFORMANCE'] as const).map((suite, index) =>
    createCapabilityConformanceReceipt({
      suite, manifestDigest, verifierId: 'independent:graph', independent: true, passed: true,
      evidenceArtifactIds: [String(index + 1).repeat(64)], observedAt: '2026-10-08T00:00:00.000Z',
      ...(suite === 'PERFORMANCE' ? { metrics: { p95LatencyMs: 5, failureRate: 0, peakMemoryMb: 16 } } : {})
    })
  );
  const certification = certifyCapabilityExtension({ manifest, receipts, certifiedAt: '2026-10-08T00:01:00.000Z' });
  const keys = crypto.generateKeyPairSync('ed25519');
  const pkg = signCapabilityPackage({
    publisherId: 'publisher:graph', manifest, certification, publishedAt: '2026-10-08T00:02:00.000Z',
    privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    build: { sourceDigest: 'a'.repeat(64), buildRecipeDigest: 'b'.repeat(64), builderId: 'builder:graph', builtAt: '2026-10-08T00:01:30.000Z', reproducible: true },
    lifecycle: { vulnerabilityChannel: 'mailto:security@example.com' }
  });
  const governance = new CapabilityGovernanceRegistry();
  governance.upsertPublisher({
    id: 'publisher:graph', displayName: 'Graph Publisher',
    publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), enabled: true
  });
  return { pkg, governance };
}

const providerCode = `import { value } from './lib/helper.mjs';
export function createCapabilityProvider() {
  return {
    name:'signed-graph-probe', supports:()=>true,
    score:()=>({reliability:1,latency:1,determinism:1,security:1,reversibility:1,informationQuality:1,interactionCost:0}),
    async execute(a) { return {ok:true,capability:a.capability,provider:'signed-graph-probe',output:{value,moduleUrl:import.meta.url},evidence:[],durationMs:1}; }
  };
}`;

async function graphFiles(t: TestContext, contents: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-signed-module-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(contents)) {
    const target = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, 'utf8');
  }
  return { root, entry: path.join(root, 'provider.mjs') };
}

const validFiles = () => ({
  'provider.mjs': providerCode,
  'lib/helper.mjs': "import { message } from './value.mjs'; export const value = message;",
  'lib/value.mjs': "export const message = 'signed-original';"
});

test('signed graph digest binds all dependencies, canonical file names and the entry', () => {
  const graph = graphFor(validFiles());
  assert.equal(graph.modules.length, 3);
  assert.match(verifiedModuleGraphDigest(graph), /^[0-9a-f]{64}$/);
  const { pkg } = signedFixture(graph);
  assert.equal(pkg.manifest.provenance.packageDigest, verifiedModuleGraphDigest(graph));
  assert.throws(() => normalizeVerifiedModuleGraph({ entry: 'provider.mjs', modules: [
    { path: 'provider.mjs', sha256: 'a'.repeat(64) },
    { path: 'Provider.mjs', sha256: 'b'.repeat(64) }
  ] }), /duplicate|case-colliding/i);
  for (const bad of ['../evil.mjs', './evil.mjs', 'lib/../evil.mjs', 'C:/evil.mjs', 'lib\\evil.mjs', 'lib/%2e%2e.mjs', '/root/evil.mjs']) {
    assert.throws(() => normalizeVerifiedModuleGraph({ entry: 'provider.mjs', modules: [
      { path: 'provider.mjs', sha256: 'a'.repeat(64) }, { path: bad, sha256: 'b'.repeat(64) }
    ] }));
  }
  const tamperedGraph = { ...graph, modules: graph.modules.map((m) =>
    m.path === 'lib/helper.mjs' ? { ...m, sha256: '0'.repeat(64) } : m
  ) };
  assert.throws(() => validateManifest({
    ...pkg.manifest, provenance: { ...pkg.manifest.provenance, moduleGraph: tamperedGraph }
  }), /digest/i);
});

test('full signed module graph loads only pinned in-memory bytes and never reopens swapped dependencies', async (t) => {
  if (!HAS_HOOKS) return t.skip('Node 22.15+ synchronous module hooks required');
  const contents = validFiles();
  const { root, entry } = await graphFiles(t, contents);
  const graph = graphFor(contents);
  const { pkg, governance } = signedFixture(graph);
  let replaced = false;
  const provider = await loadGovernedCapabilityModule({
    modulePath: entry, allowedRoots: [root], package: pkg, governance,
    readModuleBytes: async (canonicalPath) => {
      const original = await fs.readFile(canonicalPath);
      if (canonicalPath.endsWith(path.join('lib', 'value.mjs'))) {
        await fs.writeFile(canonicalPath, "export const message = 'MALICIOUS_REPLACEMENT';");
        replaced = true;
      }
      return original;
    }
  });
  t.after(() => provider.close());
  assert.equal(replaced, true);
  const action = { id: crypto.randomUUID(), capability: 'file.read', risk: 'read' as const, input: {}, provenance: { kind: 'runtime' as const } };
  const result = await provider.execute(action);
  assert.equal(result.ok, true);
  assert.equal((result.output as { value: string }).value, 'signed-original');
  assert.match((result.output as { moduleUrl: string }).moduleUrl, /^operator-verified:\/\//);
});

test('signed graph rejects undeclared imports and external native/bare modules', async (t) => {
  if (!HAS_HOOKS) return t.skip('Node 22.15+ synchronous module hooks required');
  for (const source of [
    "import './undeclared.mjs'; export const value='no';",
    "import fs from 'node:fs'; export const value='no';",
    "import pkg from 'some-external-package'; export const value='no';",
    "await import('data:text/javascript,export default 42'); export const value='no';"
  ]) {
    const files = { 'provider.mjs': providerCode, 'lib/helper.mjs': source };
    const { root, entry } = await graphFiles(t, files);
    const { pkg, governance } = signedFixture(graphFor(files));
    await assert.rejects(
      () => loadGovernedCapabilityModule({ modulePath: entry, allowedRoots: [root], package: pkg, governance }),
      (error: any) => error?.code === 'CAPABILITY_MODULE_GRAPH_INVALID'
    );
  }
});

test('dependency mutation, missing path and escaped symlinks fail before entry execution', async (t) => {
  const contents = validFiles();
  const { root, entry } = await graphFiles(t, contents);
  const graph = graphFor(contents);
  await fs.writeFile(path.join(root, 'lib', 'value.mjs'), 'export const message = "tampered";');
  await assert.rejects(() => snapshotVerifiedModuleGraph({
    entryPath: entry, graph, readModuleBytes: fs.readFile
  }), (e: any) => e?.code === 'CAPABILITY_MODULE_DIGEST_MISMATCH');
  await fs.rm(path.join(root, 'lib', 'value.mjs'));
  await assert.rejects(() => snapshotVerifiedModuleGraph({ entryPath: entry, graph, readModuleBytes: fs.readFile }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-signed-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'value.mjs'), contents['lib/value.mjs']);
  try {
    await fs.symlink(path.join(outside, 'value.mjs'), path.join(root, 'lib', 'value.mjs'), 'file');
  } catch {
    return t.skip('OS policy does not allow symlink creation here');
  }
  await assert.rejects(() => snapshotVerifiedModuleGraph({
    entryPath: entry, graph, readModuleBytes: fs.readFile
  }), (e: any) => e?.code === 'CAPABILITY_MODULE_GRAPH_INVALID');
});

test('older Node versions refuse the multi-file graph instead of unsafely importing paths', async (t) => {
  if (HAS_HOOKS) return t.skip('Runtime supports graph loader');
  const contents = validFiles();
  const { root, entry } = await graphFiles(t, contents);
  const { pkg, governance } = signedFixture(graphFor(contents));
  await assert.rejects(
    () => loadGovernedCapabilityModule({ modulePath: entry, allowedRoots: [root], package: pkg, governance }),
    (e: any) => e?.code === 'CAPABILITY_MODULE_GRAPH_RUNTIME_UNSUPPORTED'
  );
});
