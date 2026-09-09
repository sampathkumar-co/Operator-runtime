import { OperatorRuntime } from '../../../src/core/runtime.ts';
import { FilesystemProvider, GitProvider, ProcessProvider, ProjectInspectProvider, SystemInspectProvider, BrowserCdpProvider } from '../../../src/capabilities/index.ts';

export function createRuntime(config: {
  allowedRoots: string[];
  allowedExecutables: string[];
  cdpEndpoint?: string;
}): OperatorRuntime {
  return new OperatorRuntime()
    .register(new SystemInspectProvider())
    .register(new FilesystemProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProjectInspectProvider({ allowedRoots: config.allowedRoots }))
    .register(new GitProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProcessProvider({ allowedRoots: config.allowedRoots, allowedExecutables: config.allowedExecutables }))
    .register(new BrowserCdpProvider(config.cdpEndpoint));
}
