import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESERVED_PUBLIC_HOSTS = [
  'example.com',
  'example.net',
  'example.org'
];

function fail(message) {
  throw new Error(message);
}

function parseHttpsUrl(input, label) {
  let url;
  try { url = new URL(String(input ?? '').trim()); }
  catch { fail(`${label} must be a valid absolute HTTPS URL.`); }
  if (url.protocol !== 'https:' || !url.hostname) fail(`${label} must be a valid absolute HTTPS URL.`);
  if (url.username || url.password) fail(`${label} must not contain credentials.`);
  if (url.hash) fail(`${label} must not contain a fragment.`);
  return url;
}

function isReservedOrLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === 'invalid' || host.endsWith('.invalid') || host === 'example' || host.endsWith('.example') || host === 'test' || host.endsWith('.test')) return true;
  return RESERVED_PUBLIC_HOSTS.some((reserved) => host === reserved || host.endsWith(`.${reserved}`));
}
export function validateProductionReleaseInputs(input = {}) {
  const version = String(input.version ?? '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail('version must be a four-part MSIX version.');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 65_535)) {
    fail('version components must be between 0 and 65535.');
  }

  const identityName = String(input.identityName ?? '').trim();
  if (identityName !== 'SPLCART.SplcartOperator') fail('identity_name must remain SPLCART.SplcartOperator for the public bootstrap.');

  const updateBaseUri = parseHttpsUrl(input.updateBaseUri, 'update_base_uri');
  if (updateBaseUri.search) fail('update_base_uri must not contain a query string.');
  if (isReservedOrLoopbackHost(updateBaseUri.hostname)) {
    fail('update_base_uri must use a real non-loopback production host.');
  }

  const timestampUri = parseHttpsUrl(input.timestampUri, 'timestamp_uri');
  if (isReservedOrLoopbackHost(timestampUri.hostname)) {
    fail('timestamp_uri must use a real non-loopback timestamp host.');
  }

  return {
    version,
    identityName,
    updateBaseUri: updateBaseUri.href.replace(/\/$/, ''),
    timestampUri: timestampUri.href
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateProductionReleaseInputs({
    version: process.env.RELEASE_VERSION,
    updateBaseUri: process.env.UPDATE_BASE_URI,
    timestampUri: process.env.TIMESTAMP_URI,
    identityName: process.env.IDENTITY_NAME
  });
  console.log('production release inputs: PASS');
}
