import { OperatorRuntime } from '../../../src/core/runtime.ts';
import { FilesystemProvider, GitProvider, GitCheckpointProvider, GitWriteProvider, ProcessProvider, ProjectInspectProvider, ProjectCommandProvider, ProjectTransactionProvider, DockerProvider, PostgresProvider, VsCodeProvider, SystemInspectProvider, ManagedBrowserProvider, WindowsUiaProvider, SandboxedComputeProvider, PerceptionProvider, WorkspaceEditTransactionProvider, WorkspaceEditRollbackProvider, WorkspaceLspEditProvider } from '../../../src/capabilities/index.ts';
import { ProviderLearningStore } from '../../../src/core/provider-learning.ts';
import type { PerceptionGraphStore } from '../../../src/core/perception-graph.ts';

export function createRuntime(config: {
  stateDir?: string;
  allowedRoots: string[];
  allowedExecutables: string[];
  terminalAllowedExecutables?: string[];
  projectCommandRegistryPath?: string;
  dockerExecutable?: string;
  computeJavascriptImage?: string;
  computePythonImage?: string;
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
  perception?: PerceptionGraphStore;
}): OperatorRuntime {
  const runtime = new OperatorRuntime(config.stateDir ? { learning: new ProviderLearningStore(config.stateDir) } : {})
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
    .register(new SandboxedComputeProvider({
      dockerExecutable: config.dockerExecutable,
      images: {
        ...(config.computeJavascriptImage ? { javascript: config.computeJavascriptImage } : {}),
        ...(config.computePythonImage ? { python: config.computePythonImage } : {})
      }
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
      stateDir: config.stateDir,
      allowedRoots: config.allowedRoots,
      allowedExecutables: config.terminalAllowedExecutables ?? [],
      requiredRisk: 'destructive'
    }))
    .register(new ManagedBrowserProvider({
      endpoint: config.cdpEndpoint,
      autoLaunch: config.browserAutoLaunch,
      executablePath: config.browserPath,
      dataDir: config.browserDataDir
    }));
  runtime.register(new WorkspaceLspEditProvider({
    allowedRoots: config.allowedRoots,
    windowsPathLeaseExecutable: config.windowsPathLeasePath
  }));
  if (config.stateDir) {
    runtime.register(new WorkspaceEditTransactionProvider({
      allowedRoots: config.allowedRoots,
      stateDir: config.stateDir,
      windowsPathLeaseExecutable: config.windowsPathLeasePath
    }));
    runtime.register(new WorkspaceEditRollbackProvider({
      allowedRoots: config.allowedRoots,
      stateDir: config.stateDir,
      windowsPathLeaseExecutable: config.windowsPathLeasePath
    }));
  }
  if (config.perception) runtime.register(new PerceptionProvider(config.perception));
  return runtime.register(new WindowsUiaProvider({ binaryPath: config.windowsUiaPath }));
}
