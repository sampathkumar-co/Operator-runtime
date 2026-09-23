import { OperatorRuntime } from '../../../src/core/runtime.ts';
import { FilesystemProvider, GitProvider, GitCheckpointProvider, GitWriteProvider, ProcessProvider, ProjectInspectProvider, ProjectCommandProvider, ProjectTransactionProvider, DockerProvider, PostgresProvider, VsCodeProvider, SystemInspectProvider, ManagedBrowserProvider, WindowsUiaProvider } from '../../../src/capabilities/index.ts';
import { ProviderLearningStore } from '../../../src/core/provider-learning.ts';

export function createRuntime(config: {
  stateDir?: string;
  allowedRoots: string[];
  allowedExecutables: string[];
  terminalAllowedExecutables?: string[];
  projectCommandRegistryPath?: string;
  dockerExecutable?: string;
  postgresProfileRegistryPath?: string;
  psqlExecutable?: string;
  vscodeExecutable?: string;
  vscodeDataDir?: string;
  cdpEndpoint?: string;
  browserAutoLaunch?: boolean;
  browserPath?: string;
  browserDataDir?: string;
  windowsUiaPath?: string;
  windowsPathLeasePath?: string;
}): OperatorRuntime {
  return new OperatorRuntime(config.stateDir ? { learning: new ProviderLearningStore(config.stateDir) } : {})
    .register(new SystemInspectProvider())
    .register(new FilesystemProvider({ allowedRoots: config.allowedRoots, windowsPathLeaseExecutable: config.windowsPathLeasePath }))
    .register(new ProjectInspectProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProjectCommandProvider({
      allowedRoots: config.allowedRoots,
      allowedExecutables: config.allowedExecutables,
      registryPath: config.projectCommandRegistryPath
    }))
    .register(new ProjectTransactionProvider({
      allowedRoots: config.allowedRoots,
      allowedExecutables: config.allowedExecutables,
      registryPath: config.projectCommandRegistryPath
    }))
    .register(new DockerProvider({
      allowedRoots: config.allowedRoots,
      dockerExecutable: config.dockerExecutable
    }))
    .register(new PostgresProvider({
      allowedRoots: config.allowedRoots,
      registryPath: config.postgresProfileRegistryPath,
      psqlExecutable: config.psqlExecutable
    }))
    .register(new VsCodeProvider({
      allowedRoots: config.allowedRoots,
      codeExecutable: config.vscodeExecutable,
      dataDir: config.vscodeDataDir
    }))
    .register(new GitProvider({ allowedRoots: config.allowedRoots }))
    .register(new GitCheckpointProvider({ allowedRoots: config.allowedRoots }))
    .register(new GitWriteProvider({ allowedRoots: config.allowedRoots }))
    .register(new ProcessProvider({
      allowedRoots: config.allowedRoots,
      allowedExecutables: config.terminalAllowedExecutables ?? [],
      requiredRisk: 'destructive'
    }))
    .register(new ManagedBrowserProvider({
      endpoint: config.cdpEndpoint,
      autoLaunch: config.browserAutoLaunch,
      executablePath: config.browserPath,
      dataDir: config.browserDataDir
    }))
    .register(new WindowsUiaProvider({ binaryPath: config.windowsUiaPath }));
}
