import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { OperatorError } from './errors.ts';
import { requireHttpsUrlForPolicy, type HttpsTargetPolicy } from './network-authority.ts';
import type { ArtifactFetch } from './artifact-object-store.ts';

/**
 * Public hostnames are not sufficient SSRF protection: DNS resolution must be
 * checked at the socket's actual dial boundary. HTTPS uses this lookup's
 * selected address directly, rather than resolving the hostname a second time.
 */
const FORBIDDEN_IPV4 = new BlockList();
for (const [subnet, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) FORBIDDEN_IPV4.addSubnet(subnet, bits, 'ipv4');

const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');
const FORBIDDEN_IPV6 = new BlockList();
for (const [subnet, bits] of [
  ['2001::', 23], // IPv6 protocol assignments (including transition/tunnel addresses)
  ['2001:db8::', 32], // documentation
  ['2002::', 16] // 6to4 addresses embed an arbitrary IPv4 destination
] as const) FORBIDDEN_IPV6.addSubnet(subnet, bits, 'ipv6');

export function isGloballyRoutableDnsAnswer(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const family = isIP(address);
  if (family === 4) return !FORBIDDEN_IPV4.check(address, 'ipv4');
  if (family === 6) return GLOBAL_UNICAST_IPV6.check(address, 'ipv6')
    && !FORBIDDEN_IPV6.check(address, 'ipv6');
  return false;
}

export interface DnsAnswer { address: string; family: 4 | 6; }
export type ResolveDnsAnswers = (
  hostname: string,
  done: (error: NodeJS.ErrnoException | null, answers: DnsAnswer[]) => void
) => void;

const resolveWithSystemDns: ResolveDnsAnswers = (hostname, done) => {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) { done(error, []); return; }
    done(null, addresses as DnsAnswer[]);
  });
};

/**
 * The HTTP client calls this at connection time. Reject the entire DNS reply
 * if even one address is forbidden: the client must not silently fall back
 * to a less-safe A/AAAA answer.
 */
export function createPinnedPublicDnsLookup(resolveAnswers: ResolveDnsAnswers = resolveWithSystemDns) {
  return (
    hostname: string,
    options: { all?: boolean },
    done: (error: Error | null, address?: string | DnsAnswer[], family?: number) => void
  ): void => {
    resolveAnswers(hostname, (error, answers) => {
      if (error) { done(error); return; }
      if (!Array.isArray(answers) || answers.length < 1 || answers.length > 32 ||
        answers.some((item) => !item || ![4, 6].includes(item.family) ||
          isIP(item.address) !== item.family || !isGloballyRoutableDnsAnswer(item.address))) {
        done(new OperatorError(
          'UNSAFE_PUBLIC_NETWORK_TARGET',
          'Outbound DNS resolution returned a private, reserved, malformed or unbounded address.'
        ));
        return;
      }
      if (options?.all) done(null, answers);
      else done(null, answers[0]!.address, answers[0]!.family);
    });
  };
}

/**
 * No redirect following, no connection pooling and no second unvalidated DNS
 * lookup. Node's HTTPS socket verifies TLS and SNI against the original host.
 * Approved private origins remain an explicit separate operator trust decision.
 */
export function createPinnedHttpsArtifactFetch(policy: HttpsTargetPolicy): ArtifactFetch {
  const publicLookup = createPinnedPublicDnsLookup();
  return async (input, init) => {
    const url = requireHttpsUrlForPolicy(input, 'Object storage URL', policy);
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && method !== 'PUT') {
      throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID', 'Object HTTP method must be GET or PUT.');
    }
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method,
        headers: init?.headers,
        agent: false,
        lookup: policy.mode === 'public-dns' ? publicLookup as any : undefined
      }, (response) => {
        const status = response.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get(name: string): string | null {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : value ?? null;
            }
          },
          body: Readable.toWeb(response) as unknown as NonNullable<
            Awaited<ReturnType<ArtifactFetch>>['body']
          >,
          async arrayBuffer(): Promise<ArrayBuffer> {
            throw new OperatorError('ARTIFACT_OBJECT_STORE_INVALID',
              'Object responses must be streamed through the bounded reader.');
          }
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error('Object HTTPS request timed out.')));
      request.on('error', reject);
      if (init?.body) request.end(Buffer.from(init.body));
      else request.end();
    });
  };
}
