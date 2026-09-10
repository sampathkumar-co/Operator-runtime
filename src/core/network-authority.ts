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
