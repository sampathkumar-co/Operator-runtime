import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';

export const DEFAULT_MANIFEST_URL =
  'https://github.com/sampathkumar-co/Operator-runtime/releases/latest/download/release-metadata.json';
export const MINIMUM_RELEASE_VERSION = '0.1.0.0';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 30_000;
const ARTIFACT_FETCH_TIMEOUT_MS = 5 * 60_000;

function fail(message) {
  throw new Error(message);
}

export function validatePackageReleaseVersion(packageVersionInput, releaseVersionInput) {
  const packageVersion = String(packageVersionInput ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    fail('npm package version must be a stable three-part semantic version.');
  }
  const releaseVersion = String(releaseVersionInput ?? '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(releaseVersion)) {
    fail('Windows release version must be a four-part package version.');
  }
  const releaseParts = releaseVersion.split('.').map(Number);
  if (releaseParts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65_535)) {
    fail('Windows release version components must be between 0 and 65535.');
  }
  const expectedPackageVersion = releaseParts.slice(0, 3).join('.');
  if (packageVersion !== expectedPackageVersion) {
    fail(`npm package version ${packageVersion} does not match Windows release ${releaseVersion}; expected ${expectedPackageVersion}.`);
  }
  return { packageVersion, releaseVersion };
}

function cleanHttpsUrl(input, label) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    fail(`${label} must be a valid absolute URL.`);
  }
  if (url.protocol !== 'https:') fail(`${label} must use HTTPS.`);
  if (url.username || url.password) fail(`${label} must not contain credentials.`);
  if (url.hash) fail(`${label} must not contain a fragment.`);
  return url;
}

function asSha256(input, label = 'SHA-256') {
  const value = String(input ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be 64 hexadecimal characters.`);
  return value;
}

export function validateReleaseMetadata(input, { allowUntimestamped = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Release metadata must be a JSON object.');
  if (input.schemaVersion !== 1) fail('Unsupported release metadata schemaVersion.');
  if (input.product !== 'operator-runtime') fail('Release metadata product must be operator-runtime.');
  if (input.platform !== 'win32' || input.arch !== 'x64') fail('Release metadata must target win32 x64.');
  if (input.identityName !== 'SPLCART.SplcartOperator') fail('Release metadata identityName must be SPLCART.SplcartOperator.');
  if (input.signed !== true) fail('Operator bootstrap refuses unsigned release metadata.');
  if (!allowUntimestamped && input.timestamped !== true) fail('Operator bootstrap requires a timestamped production signature.');
  const version = String(input.version ?? '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail('Release version must be a four-part Windows package version.');
  const versionParts = version.split('.').map(Number);
  if (versionParts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65_535)) fail('Release version components must be between 0 and 65535.');
  const minimumParts = MINIMUM_RELEASE_VERSION.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    if (versionParts[i] === minimumParts[i]) continue;
    if (versionParts[i] < minimumParts[i]) fail(`Release ${version} is below this bootstrap's minimum trusted version ${MINIMUM_RELEASE_VERSION}.`);
    break;
  }
  const artifact = String(input.artifact ?? '');
  if (artifact !== `Operator-${version}-x64.msix`) fail('Release artifact name must match the declared version exactly.');
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ARTIFACT_BYTES) {
    fail('Release artifact size is outside the permitted range.');
  }
  const signerSubject = String(input.signerSubject ?? '').trim();
  if (!signerSubject) fail('Release signer subject is required.');
  return {
    schemaVersion: 1,
    product: 'operator-runtime',
    version,
    platform: 'win32',
    arch: 'x64',
    identityName: 'SPLCART.SplcartOperator',
    artifact,
    sha256: asSha256(input.sha256),
    sizeBytes,
    signed: true,
    timestamped: input.timestamped === true,
    signerSubject,
    signerCertificateSha256: asSha256(input.signerCertificateSha256, 'Release signer certificate SHA-256')
  };
}

export function validateTrustedSigners(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 || !Array.isArray(input.signers)) {
    fail('Trusted signer file is invalid.');
  }
  const signers = input.signers.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Trusted signer entry is invalid.');
    const subject = String(entry.subject ?? '').trim();
    if (!subject) fail('Trusted signer subject is required.');
    return { subject, certificateSha256: asSha256(entry.certificateSha256, 'Trusted signer certificate SHA-256') };
  });
  const unique = new Set(signers.map((entry) => entry.certificateSha256));
  if (unique.size !== signers.length) fail('Trusted signer fingerprints must be unique.');
  return signers;
}

export async function loadTrustedSigners(file) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  return validateTrustedSigners(parsed);
}

export function resolveArtifactUrl(metadata, manifestUrl) {
  const base = cleanHttpsUrl(manifestUrl, 'Release manifest URL');
  const artifactUrl = new URL(metadata.artifact, base);
  if (artifactUrl.protocol !== 'https:' || artifactUrl.username || artifactUrl.password || artifactUrl.hash) {
    fail('Resolved release artifact URL is unsafe.');
  }
  return artifactUrl;
}

async function readBoundedBody(response, maxBytes, label) {
  if (!response.body) fail(`${label} response has no body.`);
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) fail(`${label} returned an invalid Content-Length.`);
    if (contentLength > maxBytes) fail(`${label} exceeds the permitted size.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > maxBytes) fail(`${label} exceeds the permitted size.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchChecked(url, label, timeoutMs) {
  const target = cleanHttpsUrl(url, label);
  const response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'operator-runtime-cli/0.1.0',
        accept: 'application/octet-stream, application/json'
      }
    });
  if (!response.ok) fail(`${label} request failed with HTTP ${response.status}.`);
  cleanHttpsUrl(response.url, `${label} final URL`);
  return response;
}

export async function fetchReleaseMetadata(manifestUrl = DEFAULT_MANIFEST_URL) {
  const response = await fetchChecked(manifestUrl, 'Release manifest', MANIFEST_FETCH_TIMEOUT_MS);
  const bytes = await readBoundedBody(response, MAX_MANIFEST_BYTES, 'Release manifest');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Release manifest is not valid JSON.');
  }
  return validateReleaseMetadata(parsed);
}

export async function downloadAndVerifyArtifact(metadata, manifestUrl, destination) {
  const artifactUrl = resolveArtifactUrl(metadata, manifestUrl);
  const response = await fetchChecked(artifactUrl, 'Release artifact', ARTIFACT_FETCH_TIMEOUT_MS);
  if (!response.body) fail('Release artifact response has no body.');
  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) fail('Release artifact returned an invalid Content-Length.');
    if (declaredLength !== metadata.sizeBytes) fail('Release artifact Content-Length does not match release metadata.');
  }

  const handle = await fs.open(destination, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      bytes += chunk.length;
      if (bytes > metadata.sizeBytes || bytes > MAX_ARTIFACT_BYTES) fail('Release artifact exceeded its declared size.');
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  if (bytes !== metadata.sizeBytes) {
    await fs.rm(destination, { force: true }).catch(() => {});
    fail('Release artifact size does not match release metadata.');
  }
  const actualHash = hash.digest('hex');
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(metadata.sha256, 'hex');
  if (!crypto.timingSafeEqual(actual, expected)) {
    await fs.rm(destination, { force: true }).catch(() => {});
    fail('Release artifact SHA-256 does not match release metadata.');
  }
  return { artifactUrl: artifactUrl.href, sha256: actualHash, sizeBytes: bytes };
}

export async function verifyLocalArtifact(metadata, file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size !== metadata.sizeBytes) fail('Local release artifact size does not match metadata.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const actualHash = hash.digest('hex');
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(metadata.sha256, 'hex');
  if (!crypto.timingSafeEqual(actual, expected)) fail('Local release artifact SHA-256 does not match metadata.');
  return actualHash;
}
