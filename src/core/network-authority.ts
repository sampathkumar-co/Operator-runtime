import type { Server } from 'node:http';
import { isIP } from 'node:net';
import { OperatorError } from './errors.ts';

export function requireLiteralLoopbackBindHost(input: string, label = 'Local service'): string {
  const host = String(input ?? '').trim().toLowerCase();
  if (host === '127.0.0.1') return host;
  if (host === '::1' || host === '[::1]') return '::1';
  throw new OperatorError(
    'UNSAFE_LOCAL_BIND_HOST',
    `${label} must bind to a literal loopback address (127.0.0.1 or ::1). Remote ingress must use the approved relay/tunnel boundary.`
  );
}

export function requirePublicDnsHostname(input: string, label = 'Outbound network target'): string {
  const hostname = String(input ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0 || !hostname.includes('.')) {
    throw new OperatorError('UNSAFE_PUBLIC_NETWORK_TARGET', `${label} must use a public DNS hostname, not a literal IP or single-label host.`);
  }
  const labels = hostname.split('.');
  if (labels.some((part) => part.length < 1 || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new OperatorError('UNSAFE_PUBLIC_NETWORK_TARGET', `${label} hostname is invalid.`);
  }
  const reserved = ['localhost', 'local', 'internal', 'invalid', 'test', 'onion'];
  if (reserved.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
    || hostname === 'home.arpa' || hostname.endsWith('.home.arpa')) {
    throw new OperatorError('UNSAFE_PUBLIC_NETWORK_TARGET', `${label} must not use a reserved or private DNS hostname.`);
  }
  return hostname;
}

export type HttpsTargetPolicy =
  | { mode: 'public-dns' }
  | { mode: 'approved-origins'; origins: readonly string[] };

export function requirePublicHttpsUrl(
  input: string | URL,
  label = 'Outbound network target',
  options: { allowQuery?: boolean } = {}
): URL {
  return requireHttpsUrlForPolicy(input, label, { mode: 'public-dns' }, options);
}

export function requireHttpsUrlForPolicy(
  input: string | URL,
  label: string,
  policy: HttpsTargetPolicy,
  options: { allowQuery?: boolean } = {}
): URL {
  let url: URL;
  try { url = input instanceof URL ? new URL(input.toString()) : new URL(String(input)); }
  catch { throw unsafe(label, 'URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (options.allowQuery === false && url.search)) {
    throw unsafe(label, `must use credential-free HTTPS${options.allowQuery === false ? ' without query or fragment' : ' without a fragment'}.`);
  }
  if (policy.mode === 'public-dns') {
    requirePublicDnsHostname(url.hostname, label);
    return url;
  }
  if (policy.mode !== 'approved-origins' || !Array.isArray(policy.origins) || policy.origins.length < 1 || policy.origins.length > 256) {
    throw unsafe(label, 'target policy is invalid.');
  }
  const approved = new Set(policy.origins.map((origin) => normalizeHttpsOrigin(origin, label)));
  if (!approved.has(url.origin)) throw unsafe(label, 'origin is not explicitly approved.');
  return url;
}

function normalizeHttpsOrigin(input: string, label: string): string {
  let url: URL;
  try { url = new URL(String(input)); } catch { throw unsafe(label, 'approved origin is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw unsafe(label, 'approved origins must be credential-free HTTPS origins without path, query, or fragment.');
  }
  return url.origin;
}

function unsafe(label: string, detail: string): OperatorError {
  return new OperatorError('UNSAFE_PUBLIC_NETWORK_TARGET', `${label} ${detail}`);
}

export function applyBoundedHttpServerPolicy(server: Server): void {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 64;
}
