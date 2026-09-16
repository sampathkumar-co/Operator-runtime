import path from 'node:path';

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
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path from the hardened Windows npm runtime.`);
}

// npm/npx can prepend project-local .bin directories to PATH. Rebuild executable
// search authority before importing any capability provider so project files cannot
// shadow git/node/npm or other explicitly allowed executables.
const systemRoot = process.env.SYSTEMROOT || process.env.WINDIR || 'C:\\Windows';
const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
const trustedPath = [
  path.dirname(process.execPath),
  path.join(systemRoot, 'System32'),
  systemRoot,
  path.join(systemRoot, 'System32', 'Wbem'),
  path.join(programFiles, 'Git', 'cmd'),
  path.join(programFiles, 'nodejs'),
  path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin')
];
delete process.env.PATH;
delete process.env.Path;
process.env.Path = [...new Set(trustedPath.map((entry) => path.resolve(entry)))].join(path.delimiter);
process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

// The public npm command is intentionally pinned to the production relay authority.
// Caller environment variables cannot redirect a paired device to another relay.
process.env.OPERATOR_RELAY_URL = REQUIRED_RELAY_URL;
process.env.OPERATOR_RELAY_RESULT_URL = REQUIRED_RESULT_URL;
delete process.env.OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK;

await import('./main.ts');
