import path from 'node:path';

export type ScopedPathSyntax =
  | { kind: 'native-absolute'; value: string }
  | { kind: 'foreign-windows-absolute'; value: string }
  | { kind: 'relative'; value: string };

export function normalizeScopedPathSyntax(inputPath: string): ScopedPathSyntax {
  if (path.isAbsolute(inputPath)) {
    return { kind: 'native-absolute', value: path.resolve(inputPath) };
  }
  if (process.platform !== 'win32' && path.win32.isAbsolute(inputPath)) {
    return { kind: 'foreign-windows-absolute', value: inputPath };
  }
  return { kind: 'relative', value: inputPath.replace(/\\/g, path.sep) };
}
