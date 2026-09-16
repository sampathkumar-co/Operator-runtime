import fs from 'node:fs';
import path from 'node:path';
import { OperatorError } from './errors.ts';

const WINDOWS_NATIVE_EXTENSIONS = ['.exe', '.com'] as const;

export function resolveTrustedExecutable(
  input: string,
  source: NodeJS.ProcessEnv = process.env
): string {
  const executable = String(input ?? '').trim();
  if (!executable || executable.includes('\0')) {
    throw new OperatorError('EXECUTABLE_INVALID', 'Executable must be a non-empty path or command name without NUL bytes.');
  }

  if (path.isAbsolute(executable)) return validateNativeExecutable(executable);
  if (/[\\/]/.test(executable)) {
    throw new OperatorError('EXECUTABLE_PATH_UNTRUSTED', 'Relative executable paths are not allowed.');
  }

  const pathValue = source.PATH ?? source.Path ?? '';
  for (const rawDirectory of String(pathValue).split(path.delimiter)) {
    const directory = stripOuterQuotes(rawDirectory.trim());
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of candidateNames(executable, source)) {
      const candidate = path.resolve(directory, name);
      const resolved = tryNativeExecutable(candidate);
      if (resolved) return resolved;
    }
  }

  throw new OperatorError('EXECUTABLE_NOT_FOUND', `Trusted executable ${executable} was not found in absolute PATH directories.`);
}
function candidateNames(executable: string, source: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [executable];
  const extension = path.win32.extname(executable).toLowerCase();
  if (extension) {
    if (!WINDOWS_NATIVE_EXTENSIONS.includes(extension as '.exe' | '.com')) {
      throw new OperatorError('EXECUTABLE_SCRIPT_DENIED', 'Windows command scripts are not valid shell-free executable authority.');
    }
    return [executable];
  }
  void source;
  return WINDOWS_NATIVE_EXTENSIONS.map((item) => `${executable}${item}`);
}

function validateNativeExecutable(candidate: string): string {
  const resolved = tryNativeExecutable(candidate);
  if (!resolved) throw new OperatorError('EXECUTABLE_NOT_FOUND', `Trusted executable does not exist or is not executable: ${candidate}`);
  return resolved;
}

function tryNativeExecutable(candidate: string): string | undefined {
  if (process.platform === 'win32') {
    const extension = path.win32.extname(candidate).toLowerCase();
    if (!WINDOWS_NATIVE_EXTENSIONS.includes(extension as '.exe' | '.com')) return undefined;
  }
  try {
    const resolved = fs.realpathSync.native(candidate);
    if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) return undefined;
    if (process.platform !== 'win32') fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
