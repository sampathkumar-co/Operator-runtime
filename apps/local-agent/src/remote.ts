const REQUIRED_RELAY_URL = 'wss://operator.splcart.in/device';
const REQUIRED_RESULT_URL = 'https://operator.splcart.in/v1/device-result';

if (!process.env.OPERATOR_AGENT_TOKEN || process.env.OPERATOR_AGENT_TOKEN.length < 32) {
  throw new Error('Operator remote requires an ephemeral local agent token from the trusted launcher.');
}
if (!process.env.OPERATOR_RECOVERY_TOKEN || process.env.OPERATOR_RECOVERY_TOKEN.length < 32) {
  throw new Error('Operator remote requires an ephemeral recovery token from the trusted launcher.');
}
if (!process.env.OPERATOR_ALLOWED_ROOTS) {
  throw new Error('Operator remote requires an explicit authorized root from the trusted launcher.');
}
for (const [name, value] of [
  ['OPERATOR_WINDOWS_DPAPI_PATH', process.env.OPERATOR_WINDOWS_DPAPI_PATH],
  ['OPERATOR_WINDOWS_UIA_PATH', process.env.OPERATOR_WINDOWS_UIA_PATH],
  ['OPERATOR_WINDOWS_PATH_LEASE_PATH', process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH]
] as const) {
  if (!value) throw new Error(`${name} is required by the hardened Windows npm runtime.`);
}

// The public npm command is intentionally pinned to the production relay authority.
// Caller environment variables cannot redirect a paired device to another relay.
process.env.OPERATOR_RELAY_URL = REQUIRED_RELAY_URL;
process.env.OPERATOR_RELAY_RESULT_URL = REQUIRED_RESULT_URL;
delete process.env.OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK;

await import('./main.ts');
