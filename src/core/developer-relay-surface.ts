import { CAPABILITY_RISK_RULES } from './capability-policy.ts';
import { OperatorError } from './errors.ts';
import { PUBLIC_PLUGIN_CAPABILITIES } from './public-plugin-surface.ts';

export const DEVELOPER_RELAY_CAPABILITIES = Object.freeze(
  Object.keys(CAPABILITY_RISK_RULES).sort()
);

export function developerAccountIds(input: string | undefined): Set<string> {
  if (input === undefined || input.trim() === '') return new Set();
  const values = input.split(',').map((value) => value.trim()).filter(Boolean);
  const output = new Set<string>();
  for (const value of values) {
    const normalized = normalizedAccountId(value);
    if (output.has(normalized)) {
      throw new OperatorError('DEVELOPER_ACCOUNT_CONFIG_INVALID', 'Developer account allowlist contains a duplicate account ID.');
    }
    output.add(normalized);
  }
  return output;
}

export function isDeveloperAccount(accountIdInput: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return developerAccountIds(env.OPERATOR_DEVELOPER_ACCOUNT_IDS).has(normalizedAccountId(accountIdInput));
}

export function relaySessionScopesForAccount(accountIdInput: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const developer = isDeveloperAccount(accountIdInput, env);
  const capabilities = developer ? DEVELOPER_RELAY_CAPABILITIES : PUBLIC_PLUGIN_CAPABILITIES;
  return [
    'relay:connect',
    'relay:result',
    ...(developer ? ['relay:developer'] : []),
    ...capabilities.map((capability) => `cap:${capability}`)
  ];
}

function normalizedAccountId(input: string): string {
  const value = String(input ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new OperatorError('DEVELOPER_ACCOUNT_CONFIG_INVALID', 'Developer account allowlist entries must be UUIDs.');
  }
  return value;
}
