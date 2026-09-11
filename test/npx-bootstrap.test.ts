import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MANIFEST_URL,
  downloadAndVerifyArtifact,
  resolveArtifactUrl,
  validateReleaseMetadata,
  validateTrustedSigners
} from '../packages/operator-runtime-cli/src/release.mjs';
import { requireSignatureMatchesMetadata, requireTrustedSigner, windowsPowerShellEnvironment } from '../packages/operator-runtime-cli/src/windows.mjs';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    product: 'operator-runtime',
    version: '1.2.3.4',
    platform: 'win32',
    arch: 'x64',
    identityName: 'Operator.Runtime',
    artifact: 'Operator-1.2.3.4-x64.msix',
    sha256: 'a'.repeat(64),
    sizeBytes: 12345,
    signed: true,
    timestamped: true,
    signerSubject: 'CN=Operator Production',
    signerCertificateSha256: 'b'.repeat(64),
    ...overrides
  };
}

test('Windows PowerShell bootstrap child rebuilds its native module search path', () => {
  const source = { Path: 'C:\\Windows\\System32', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', KEEP: 'yes' };
  const env = windowsPowerShellEnvironment(source);
  assert.equal(env.Path, source.Path);
  assert.equal(env.KEEP, 'yes');
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'psmodulepath'), false);
  assert.equal(source.PSModulePath, 'C:\\Program Files\\PowerShell\\7\\Modules');
});

test('npx bootstrap validates production metadata and derives the release artifact URL', () => {
  const parsed = validateReleaseMetadata(metadata());
  assert.equal(parsed.version, '1.2.3.4');
  assert.equal(
    resolveArtifactUrl(parsed, DEFAULT_MANIFEST_URL).href,
    'https://github.com/sampathkumar-co/Operator-runtime/releases/latest/download/Operator-1.2.3.4-x64.msix'
  );
});

test('npx bootstrap fails closed for unsigned or untimestamped production metadata', () => {
  assert.throws(() => validateReleaseMetadata(metadata({ signed: false })), /refuses unsigned/);
  assert.throws(() => validateReleaseMetadata(metadata({ timestamped: false })), /timestamped production signature/);
});

test('npx bootstrap rejects unsafe release fields and oversized artifacts', () => {
  assert.throws(() => validateReleaseMetadata(metadata({ artifact: '../evil.msix' })), /artifact name/);
  assert.throws(() => validateReleaseMetadata(metadata({ identityName: 'Other.App' })), /identityName/);
  assert.throws(() => validateReleaseMetadata(metadata({ sizeBytes: 600 * 1024 * 1024 })), /permitted range/);
});

test('release metadata binds artifact name, Windows version range, and signer identity', () => {
  assert.throws(() => validateReleaseMetadata(metadata({ artifact: 'Operator-9.9.9.9-x64.msix' })), /declared version exactly/);
  assert.throws(() => validateReleaseMetadata(metadata({ version: '1.2.3.65536', artifact: 'Operator-1.2.3.65536-x64.msix' })), /between 0 and 65535/);
  assert.throws(() => validateReleaseMetadata(metadata({ signerSubject: '' })), /signer subject/);
  assert.throws(() => validateReleaseMetadata(metadata({ signerCertificateSha256: 'bad' })), /64 hexadecimal/);
  const parsed = validateReleaseMetadata(metadata());
  assert.doesNotThrow(() => requireSignatureMatchesMetadata({ subject: parsed.signerSubject, certificateSha256: parsed.signerCertificateSha256 }, parsed));
  assert.throws(() => requireSignatureMatchesMetadata({ subject: parsed.signerSubject, certificateSha256: 'c'.repeat(64) }, parsed), /certificate does not match/);
  assert.throws(() => requireSignatureMatchesMetadata({ subject: 'CN=Other', certificateSha256: parsed.signerCertificateSha256 }, parsed), /subject does not match/);
});

test('bootstrap rejects releases below its locally pinned minimum version', () => {
  assert.throws(() => validateReleaseMetadata(metadata({ version: '0.0.9.9', artifact: 'Operator-0.0.9.9-x64.msix' })), /minimum trusted version/);
  assert.equal(validateReleaseMetadata(metadata({ version: '0.1.0.0', artifact: 'Operator-0.1.0.0-x64.msix' })).version, '0.1.0.0');
});

test('trusted signer allowlist pins both certificate SHA-256 and subject', () => {
  const signers = validateTrustedSigners({
    schemaVersion: 1,
    signers: [{ subject: 'CN=Operator Production', certificateSha256: 'b'.repeat(64) }]
  });
  assert.deepEqual(
    requireTrustedSigner({ subject: 'CN=Operator Production', certificateSha256: 'b'.repeat(64) }, signers),
    signers[0]
  );
  assert.throws(
    () => requireTrustedSigner({ subject: 'CN=Operator Production', certificateSha256: 'c'.repeat(64) }, signers),
    /not trusted/
  );
  assert.throws(
    () => requireTrustedSigner({ subject: 'CN=Wrong', certificateSha256: 'b'.repeat(64) }, signers),
    /subject/
  );
});

test('trusted signer configuration rejects duplicates and malformed fingerprints', () => {
  assert.throws(
    () => validateTrustedSigners({ schemaVersion: 1, signers: [{ subject: 'CN=X', certificateSha256: 'bad' }] }),
    /64 hexadecimal/
  );
  assert.throws(
    () => validateTrustedSigners({
      schemaVersion: 1,
      signers: [
        { subject: 'CN=X', certificateSha256: 'd'.repeat(64) },
        { subject: 'CN=Y', certificateSha256: 'd'.repeat(64) }
      ]
    }),
    /unique/
  );
});


test('artifact download accepts a valid streamed response without Content-Length', async () => {
  const body = Buffer.from('operator-msix-test-body');
  const meta = validateReleaseMetadata(metadata({
    sizeBytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex')
  }));
  const originalFetch = globalThis.fetch;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-npx-download-'));
  const destination = path.join(temp, meta.artifact);
  globalThis.fetch = async () => { const response = new Response(body, { status: 200, headers: {} }); Object.defineProperty(response, 'url', { value: 'https://github.com/sampathkumar-co/Operator-runtime/releases/download/v1.2.3.4/' + meta.artifact }); return response; };
  try {
    const result = await downloadAndVerifyArtifact(meta, DEFAULT_MANIFEST_URL, destination);
    assert.equal(result.sizeBytes, body.length);
    assert.deepEqual(await fs.readFile(destination), body);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Windows bootstrap uses normal Add-AppxPackage install semantics', async () => {
  const source = await fs.readFile(path.resolve('packages/operator-runtime-cli/src/windows.mjs'), 'utf8');
  assert.match(source, /Add-AppxPackage -Path/);
  assert.doesNotMatch(source, /ForceUpdateFromAnyVersion/);
  assert.match(source, /Get-AppPackageLog -ActivityID/);
});
