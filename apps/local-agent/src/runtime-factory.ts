import { OperatorRuntime } from '../../../src/core/runtime.ts';
import { FilesystemProvider, GitProvider, GitCheckpointProvider, ProcessProvider, ProjectInspectProvider, SystemInspectProvider, ManagedBrowserProvider, WindowsUiaProvider } from '../../../src/capabilities/index.ts';

export function createRuntime(config: {
  allowedRoots: string[];
  allowedExecutables: string[];
  cdpEndpoint?: string;
  browserAutoLaunch?: boolean;
  browserPath?: string;
  browserDataDir?: string;
  windowsUiaPath?: string;
}): OperatorRuntime {
  return new OperatorRuntime()
    .register(new SystemInspectProvider())
    .register(new FilesystemProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProjectInspectProvider({ allowedRoots: config.allowedRoots }))
    .register(new GitProvider({ allowedRoots: config.allowedRoots }))
    .register(new GitCheckpointProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProcessProvider({ allowedRoots: config.allowedRoots, allowedExecutables: config.allowedExecutables }))
    .register(new ManagedBrowserProvider({
      endpoint: config.cdpEndpoint,
      autoLaunch: config.browserAutoLaunch,
      executablePath: config.browserPath,
      dataDir: config.browserDataDir
    }))
    .register(new WindowsUiaProvider({ binaryPath: config.windowsUiaPath }));
}
