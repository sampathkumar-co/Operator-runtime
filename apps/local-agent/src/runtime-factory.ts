import path from 'node:path';
import { OperatorRuntime } from '../../../src/core/runtime.ts';
import { OperatorError } from '../../../src/core/errors.ts';
import { DeveloperWorktreeProvider } from '../../../src/capabilities/developer-worktree.ts';
import { FilesystemProvider, GitProvider, GitCheckpointProvider, GitWriteProvider, ProcessProvider, ProjectInspectProvider, ProjectCommandProvider, ProjectTransactionProvider, DockerProvider, PostgresProvider, VsCodeProvider, SystemInspectProvider, ManagedBrowserProvider, WindowsUiaProvider, SandboxedComputeProvider, PerceptionProvider, WorkspaceEditTransactionProvider, WorkspaceEditRollbackProvider, WorkspaceLspEditProvider, DocumentDataProvider } from '../../../src/capabilities/index.ts';
import { ProviderLearningStore } from '../../../src/core/provider-learning.ts';
import { ArtifactStore } from '../../../src/core/artifact-store.ts';
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
  /** Explicit owner-controlled opt-in. Never set by public MCP or defaults. */
  developerWorktree?: { enabled: true; worktreeRoot: string };
 }): OperatorRuntime {
  if (config.developerWorktree !== undefined) {
    const optIn = config.developerWorktree;
    if (!optIn || typeof optIn !== 'object' || Array.isArray(optIn) ||
        Object.getPrototypeOf(optIn) !== Object.prototype ||
        Object.getOwnPropertyDescriptor(optIn, 'enabled')?.value !== true ||
        typeof Object.getOwnPropertyDescriptor(optIn, 'worktreeRoot')?.value !== 'string' ||
        !path.isAbsolute(optIn.worktreeRoot) || optIn.worktreeRoot.includes('\0') ||
        !config.stateDir || !Array.isArray(config.allowedRoots) ||
        config.allowedRoots.length < 1 || config.allowedRoots.some(root =>
          typeof root !== 'string' || !path.isAbsolute(root))) {
      throw new OperatorError('DEVELOPER_WORKTREE_OPT_IN_INVALID',
        'Private worktrees require exact local opt-in, a durable state directory, explicit registered roots and an absolute worktree location.');
    }
  }
  const runtime = new OperatorRuntime(config.stateDir ? { learning: new ProviderLearningStore(config.stateDir) } : {})
    .register(new SystemInspectProvider())
    .register(new FilesystemProvider({ allowedRoots: config.allowedRoots, windowsPathLeaseExecutable: config.windowsPathLeasePath }))
    .register(new ProjectInspectProvider({
      allowedRoots: config.allowedRoots,
      windowsPathLeaseExecutable: config.windowsPathLeasePath
    }))
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
  if (config.developerWorktree?.enabled === true) {
    // Opt-in never broadens roots: only the factory's already registered
    // permitted roots may be used. Authorization, risk, lease and recovery
    // checks still run through the ordinary canonical runtime pipeline.
    runtime.register(new DeveloperWorktreeProvider({
      allowedRepositoryRoots: config.allowedRoots,
      stateDir: config.stateDir!,
      worktreeRoot: config.developerWorktree.worktreeRoot
    }));
  }
  if (config.perception) runtime.register(new PerceptionProvider(config.perception));
  runtime.register(new DocumentDataProvider({ allowedRoots: config.allowedRoots }));
  return runtime.register(new WindowsUiaProvider({
    binaryPath: config.windowsUiaPath,
    ...(config.stateDir ? {artifactStore:new ArtifactStore(config.stateDir)} : {})
  }));
}
