import { resolveSupportedGitExecutable } from '../src/core/trusted-executable.ts';

export function supportedGitAvailable(): boolean {
  try {
    resolveSupportedGitExecutable(process.env);
    return true;
  } catch {
    return false;
  }
}
