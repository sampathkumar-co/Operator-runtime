export type ChildEnvironmentProfile = 'desktop' | 'windows-native';

const DESKTOP_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'USER', 'USERNAME', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'SHELL',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  'DBUS_SESSION_BUS_ADDRESS'
] as const;

const WINDOWS_NATIVE_ENV_KEYS = [
  'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'TMP', 'TEMP'
] as const;

export function safeChildEnvironment(
  profile: ChildEnvironmentProfile,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const keys = profile === 'desktop' ? DESKTOP_ENV_KEYS : WINDOWS_NATIVE_ENV_KEYS;
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}