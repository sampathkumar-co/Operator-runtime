import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_RELAY_URL = 'wss://operator.splcart.in/device';
const REQUIRED_RESULT_URL = 'https://operator.splcart.in/v1/device-result';
const remoteDir = path.dirname(fileURLToPath(import.meta.url));
const nativeRoot = path.resolve(remoteDir, '..', '..', '..', '..', 'native');
const expectedHelpers = {
  OPERATOR_WINDOWS_DPAPI_PATH: path.join(nativeRoot, 'operator-windows-dpapi.exe'),
  OPERATOR_WINDOWS_UIA_PATH: path.join(nativeRoot, 'operator-windows-uia.exe'),
  OPERATOR_WINDOWS_PATH_LEASE_PATH: path.join(nativeRoot, 'operator-windows-path-lease.exe')
} as const;

if (!process.env.OPERATOR_AGENT_TOKEN || process.env.OPERATOR_AGENT_TOKEN.length < 32) {
  throw new Error('Operator remote requires an ephemeral local agent token from the trusted launcher.');
}
if (!process.env.OPERATOR_RECOVERY_TOKEN || process.env.OPERATOR_RECOVERY_TOKEN.length < 32) {
  throw new Error('Operator remote requires an ephemeral recovery token from the trusted launcher.');
}
if (!process.env.OPERATOR_ALLOWED_ROOTS) {
  throw new Error('Operator remote requires an explicit authorized root from the trusted launcher.');
}
for (const [name, expected] of Object.entries(expectedHelpers)) {
  const configured = process.env[name];
  if (!configured || !sameWindowsPath(configured, expected)) {
    throw new Error(`${name} must reference the native helper bundled with the verified npm payload.`);
  }
  process.env[name] = expected;
}

// npm/npx parent environment is caller-controlled. Resolve Windows executable and
// profile roots through the bundled native helper before importing any provider.
const roots = trustedWindowsRoots(expectedHelpers.OPERATOR_WINDOWS_PATH_LEASE_PATH);
const trustedPath = [
  path.dirname(process.execPath),
  roots.SYSTEM,
  roots.WINDOWS,
  path.join(roots.SYSTEM, 'Wbem'),
  path.join(roots.PROGRAMFILES, 'Git', 'cmd'),
  path.join(roots.PROGRAMFILES_X86, 'Git', 'cmd'),
  path.join(roots.PROGRAMFILES, 'nodejs'),
  path.join(roots.PROGRAMFILES_X86, 'nodejs'),
  path.join(roots.PROGRAMFILES, 'Docker', 'Docker', 'resources', 'bin')
];

for (const key of [
  'PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'
]) delete process.env[key];
process.env.SYSTEMROOT = roots.WINDOWS;
process.env.WINDIR = roots.WINDOWS;
process.env.PROGRAMFILES = roots.PROGRAMFILES;
process.env['PROGRAMFILES(X86)'] = roots.PROGRAMFILES_X86;
process.env.PROGRAMW6432 = roots.PROGRAMFILES;
process.env.USERPROFILE = roots.USERPROFILE;
process.env.HOME = roots.USERPROFILE;
const profileRoot = path.win32.parse(roots.USERPROFILE).root;
process.env.HOMEDRIVE = profileRoot.slice(0, -1);
process.env.HOMEPATH = roots.USERPROFILE.slice(Math.max(0, profileRoot.length - 1));
process.env.LOCALAPPDATA = roots.LOCALAPPDATA;
process.env.APPDATA = roots.APPDATA;
process.env.PROGRAMDATA = roots.PROGRAMDATA;
process.env.TEMP = path.join(roots.LOCALAPPDATA, 'Temp');
process.env.TMP = process.env.TEMP;
process.env.PATH = [...new Set(trustedPath.map((entry) => path.win32.resolve(entry)))].join(';');
process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

// The public npm command is intentionally pinned to the production relay authority.
process.env.OPERATOR_RELAY_URL = REQUIRED_RELAY_URL;
process.env.OPERATOR_RELAY_RESULT_URL = REQUIRED_RESULT_URL;
process.env.OPERATOR_RELAY_REQUIRED = '1';
delete process.env.OPERATOR_RELAY_ALLOW_INSECURE_LOOPBACK;

await import('./main.ts');

type TrustedWindowsRoots = {
  WINDOWS: string;
  SYSTEM: string;
  PROGRAMFILES: string;
  PROGRAMFILES_X86: string;
  USERPROFILE: string;
  LOCALAPPDATA: string;
  APPDATA: string;
  PROGRAMDATA: string;
};

function trustedWindowsRoots(helper: string): TrustedWindowsRoots {
  let output: string;
  try {
    output = execFileSync(helper, ['system-roots'], {
      encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 32 * 1024, env: {}
    });
  } catch {
    throw new Error('Operator could not derive trusted Windows known folders from its native helper.');
  }
  const required = new Set<keyof TrustedWindowsRoots>([
    'WINDOWS', 'SYSTEM', 'PROGRAMFILES', 'PROGRAMFILES_X86',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA'
  ]);
  const parsed = new Map<string, string>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Operator native known-folder response is invalid.');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!required.has(key as keyof TrustedWindowsRoots) || parsed.has(key)) {
      throw new Error('Operator native known-folder response is invalid.');
    }
    if (!path.win32.isAbsolute(value) || /[\0\r\n;]/.test(value)) {
      throw new Error(`Operator native known folder ${key} is invalid.`);
    }
    parsed.set(key, path.win32.normalize(value));
  }
  for (const key of required) if (!parsed.has(key)) throw new Error(`Operator native known folder ${key} is missing.`);
  const roots = Object.fromEntries(parsed) as TrustedWindowsRoots;
  if (!sameWindowsPath(roots.SYSTEM, path.win32.join(roots.WINDOWS, 'System32'))) {
    throw new Error('Operator native Windows system root relationship is invalid.');
  }
  return roots;
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}
