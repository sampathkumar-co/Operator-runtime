import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { readDurableStateText } from '../core/durable-state.ts';
import { PathScope } from './path-scope.ts';
import { ProcessProvider } from './process.ts';

const SCORE: CapabilityScore = {
  reliability: 0.99,
  latency: 0.96,
  determinism: 0.99,
  security: 0.98,
  reversibility: 0.8,
  informationQuality: 0.99,
  interactionCost: 0.01
};

const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_COMMANDS_PER_PROJECT = 100;
const MAX_ARTIFACTS_PER_COMMAND = 50;
const MAX_JSON_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_HASH_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const REGISTRY_OPTIONS = {
  maxBytes: MAX_REGISTRY_BYTES,
  errorCode: 'COMMAND_REGISTRY_INVALID',
  invalidMessage: 'Trusted command registry is invalid.'
} as const;

type TrustedArtifact = {
  path: string;
  kind: 'file' | 'directory' | 'json';
  minBytes: number;
  mustChange: boolean;
};

type TrustedCommand = {
  id: string;
  title?: string;
  kind?: 'build' | 'test' | 'lint' | 'format' | 'dev' | 'database' | 'custom';
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  risk: 'read' | 'write' | 'external';
  artifacts: TrustedArtifact[];
};

type TrustedProject = {
  root: string;
  commands: TrustedCommand[];
};

type Registry = {
  version: 1;
  projects: TrustedProject[];
};

type ArtifactSnapshot = {
  path: string;
  exists: boolean;
  type?: 'file' | 'directory' | 'symlink' | 'other';
  size?: number;
  fingerprint?: string;
};

type ArtifactValidation = {
  path: string;
  kind: TrustedArtifact['kind'];
  passed: boolean;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
  before: ArtifactSnapshot;
  after: ArtifactSnapshot;
};

export class ProjectCommandProvider implements CapabilityProvider {
  readonly name = 'project.command.trusted';
  #scope: PathScope;
  #allowedRoots: string[];
  #allowedExecutables: Set<string>;
  #registryPath: string;

  constructor(options: { allowedRoots: string[]; allowedExecutables: string[]; registryPath?: string }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.#allowedExecutables = new Set(options.allowedExecutables.map((value) => value.toLowerCase()));
    this.#registryPath = path.resolve(options.registryPath ?? path.join(os.homedir(), '.operator', 'project-commands.json'));
  }

  supports(action: ActionRequest): boolean {
    return ['project.command.inspect', 'project.command.run'].includes(action.capability);
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      const projectRoot = await this.#scope.resolveExisting(String(action.input.path ?? action.input.cwd ?? ''));
      const registry = await this.#readRegistry();
      const project = await this.#matchProject(registry, projectRoot);

      if (action.capability === 'project.command.inspect') {
        return {
          ok: true,
          capability: action.capability,
          provider: this.name,
          output: {
            projectRoot,
            registryConfigured: registry !== null,
            registryLocation: 'operator-local-config',
            commands: project?.commands.map(({ id, title, kind, executable, args, cwd, timeoutMs, risk, artifacts }) => ({
              id,
              title,
              kind,
              executable,
              args,
              cwd,
              timeoutMs,
              risk,
              artifacts
            })) ?? []
          },
          evidence: [
            evidence('command_registry', 'pass', 'Returned only commands from the trusted local Operator registry; project manifests were not treated as executable authority.', {
              projectRoot,
              commandCount: project?.commands.length ?? 0,
              registryConfigured: registry !== null
            })
          ],
          durationMs: Math.round(performance.now() - started)
        };
      }

      if (!project) throw new OperatorError('PROJECT_COMMANDS_NOT_REGISTERED', 'No trusted command registry entry exists for this project.');
      const commandId = validateCommandId(String(action.input.commandId ?? ''));
      const command = project.commands.find((candidate) => candidate.id === commandId);
      if (!command) throw new OperatorError('PROJECT_COMMAND_NOT_REGISTERED', `Trusted command ${commandId} is not registered for this project.`);

      const expectedRisk = String(action.input.expectedRisk ?? '');
      if (expectedRisk !== command.risk) {
        throw new OperatorError('PROJECT_COMMAND_RISK_MISMATCH', 'Caller must acknowledge the command risk declared in the trusted registry.', {
          details: { expectedRisk, registeredRisk: command.risk }
        });
      }
      if (action.risk !== command.risk) {
        throw new OperatorError('PROJECT_COMMAND_ACTION_RISK_MISMATCH', 'The action risk evaluated by local policy must exactly match the trusted registry risk.', {
          details: { actionRisk: action.risk, registeredRisk: command.risk }
        });
      }

      const cwd = await resolveCommandCwd(projectRoot, command.cwd);
      const beforeArtifacts = await snapshotArtifacts(projectRoot, command.artifacts);
      const process = new ProcessProvider({
        allowedRoots: [projectRoot],
        allowedExecutables: [...this.#allowedExecutables]
      });
      const result = await process.execute({
        ...action,
        capability: 'terminal.execute',
        risk: command.risk as ActionRisk,
        input: {
          executable: command.executable,
          args: command.args,
          cwd,
          timeoutMs: command.timeoutMs
        },
        provenance: { kind: 'trusted_policy', source: `project-command:${command.id}` }
      });

      const baseOutput = {
        command: {
          id: command.id,
          title: command.title,
          kind: command.kind,
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          risk: command.risk,
          artifacts: command.artifacts
        },
        execution: result.output
      };

      if (!result.ok) {
        return {
          ...result,
          capability: action.capability,
          provider: this.name,
          output: {
            ...baseOutput,
            validation: {
              configured: command.artifacts.length > 0,
              passed: false,
              skipped: true,
              reason: 'command_failed',
              artifacts: []
            }
          },
          evidence: [
            evidence('command_registry', 'pass', 'Executed an explicitly registered trusted project command through the shell-free process provider.', {
              commandId: command.id,
              executable: command.executable,
              risk: command.risk,
              cwd
            }),
            ...result.evidence
          ]
        };
      }

      const validations = await validateArtifacts(projectRoot, command.artifacts, beforeArtifacts);
      const validationPassed = validations.every((item) => item.passed);
      const validation = {
        configured: command.artifacts.length > 0,
        passed: validationPassed,
        skipped: false,
        artifacts: validations
      };
      const validationEvidence = command.artifacts.length === 0
        ? evidence('artifact_validation', 'info', 'Trusted command has no declared artifact validators.', { commandId: command.id })
        : evidence('artifact_validation', validationPassed ? 'pass' : 'fail', validationPassed
          ? 'All trusted artifact postconditions passed.'
          : 'One or more trusted artifact postconditions failed.', {
          commandId: command.id,
          artifactCount: validations.length,
          failed: validations.filter((item) => !item.passed).map((item) => item.path)
        });

      return {
        ...result,
        ok: validationPassed,
        capability: action.capability,
        provider: this.name,
        output: { ...baseOutput, validation },
        evidence: [
          evidence('command_registry', 'pass', 'Executed an explicitly registered trusted project command through the shell-free process provider.', {
            commandId: command.id,
            executable: command.executable,
            risk: command.risk,
            cwd
          }),
          ...result.evidence,
          validationEvidence
        ],
        error: validationPassed ? undefined : {
          code: 'ARTIFACT_VALIDATION_FAILED',
          message: 'Command exited successfully but trusted artifact validation failed.',
          retryable: false
        }
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('PROJECT_COMMAND_ERROR', error instanceof Error ? error.message : String(error));
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('command_registry', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #readRegistry(): Promise<Registry | null> {
    for (const root of this.#allowedRoots) {
      if (isWithin(this.#registryPath, root)) {
        throw new OperatorError('COMMAND_REGISTRY_INSIDE_PROJECT_DENIED', 'Trusted command registry must live outside all project-authorized roots so project files cannot rewrite execution authority.', {
          details: { registryPath: this.#registryPath }
        });
      }
    }

    let raw: string;
    try {
      raw = await readDurableStateText(this.#registryPath, REGISTRY_OPTIONS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new OperatorError('COMMAND_REGISTRY_INVALID', 'Trusted command registry is not valid JSON.');
    }
    return validateRegistry(parsed, this.#allowedExecutables);
  }

  async #matchProject(registry: Registry | null, requestedRoot: string): Promise<TrustedProject | undefined> {
    if (!registry) return undefined;
    const canonicalAllowedRoots = await Promise.all(this.#allowedRoots.map(async (root) => {
      try { return await fs.realpath(root); } catch { return root; }
    }));
    for (const project of registry.projects) {
      const plausiblyInScope = this.#allowedRoots.some((root) => isWithin(project.root, root))
        || canonicalAllowedRoots.some((root) => isWithin(project.root, root));
      if (!plausiblyInScope) continue;
      let canonical: string;
      try {
        canonical = await this.#scope.resolveExisting(project.root);
      } catch (error) {
        if (error instanceof OperatorError && error.code === 'PATH_OUTSIDE_SCOPE') continue;
        throw error;
      }
      if (canonical === requestedRoot) return { ...project, root: canonical };
    }
    return undefined;
  }
}

function validateRegistry(input: unknown, allowedExecutables: Set<string>): Registry {
  if (!input || typeof input !== 'object') throw new OperatorError('COMMAND_REGISTRY_INVALID', 'Trusted command registry must be an object.');
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.projects) || raw.projects.length > 100) {
    throw new OperatorError('COMMAND_REGISTRY_INVALID', 'Trusted command registry requires version=1 and at most 100 projects.');
  }
  const projects = raw.projects.map((entry, projectIndex): TrustedProject => {
    if (!entry || typeof entry !== 'object') throw new OperatorError('COMMAND_REGISTRY_INVALID', `Project entry ${projectIndex} is invalid.`);
    const project = entry as Record<string, unknown>;
    const root = String(project.root ?? '');
    if (!path.isAbsolute(root)) throw new OperatorError('COMMAND_REGISTRY_INVALID', `Project ${projectIndex} root must be absolute.`);
    if (!Array.isArray(project.commands) || project.commands.length > MAX_COMMANDS_PER_PROJECT) {
      throw new OperatorError('COMMAND_REGISTRY_INVALID', `Project ${projectIndex} commands must be an array of at most ${MAX_COMMANDS_PER_PROJECT}.`);
    }
    const seen = new Set<string>();
    const commands = project.commands.map((candidate, commandIndex): TrustedCommand => {
      if (!candidate || typeof candidate !== 'object') throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandIndex} is invalid.`);
      const command = candidate as Record<string, unknown>;
      const id = validateCommandId(String(command.id ?? ''));
      if (seen.has(id)) throw new OperatorError('COMMAND_REGISTRY_INVALID', `Duplicate command id ${id}.`);
      seen.add(id);
      const executable = String(command.executable ?? '');
      if (!/^[A-Za-z0-9._+-]+(?:\.exe)?$/i.test(executable) || !allowedExecutables.has(executable.toLowerCase())) {
        throw new OperatorError('COMMAND_EXECUTABLE_DENIED', `Command ${id} executable is not in the local-agent executable allowlist.`);
      }
      const args = Array.isArray(command.args) ? command.args.map((value) => String(value)) : [];
      if (args.length > 200 || args.some((arg) => arg.length > 4000 || arg.includes('\0'))) {
        throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${id} arguments exceed bounds.`);
      }
      const cwd = String(command.cwd ?? '.');
      if (path.isAbsolute(cwd) || cwd.includes('\0')) throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${id} cwd must be relative.`);
      const timeoutMs = Math.min(Math.max(Number(command.timeoutMs ?? DEFAULT_TIMEOUT_MS), 100), 10 * 60_000);
      const risk = String(command.risk ?? 'write');
      if (!['read', 'write', 'external'].includes(risk)) throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${id} risk is invalid.`);
      const kind = typeof command.kind === 'string' && ['build', 'test', 'lint', 'format', 'dev', 'database', 'custom'].includes(command.kind)
        ? command.kind as TrustedCommand['kind']
        : undefined;
      const title = typeof command.title === 'string' ? command.title.trim().slice(0, 160) || undefined : undefined;
      const rawArtifacts = command.artifacts === undefined ? [] : command.artifacts;
      if (!Array.isArray(rawArtifacts) || rawArtifacts.length > MAX_ARTIFACTS_PER_COMMAND) {
        throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${id} artifacts must be an array of at most ${MAX_ARTIFACTS_PER_COMMAND}.`);
      }
      const artifacts = rawArtifacts.map((rawArtifact, artifactIndex): TrustedArtifact => validateArtifact(rawArtifact, id, artifactIndex));
      return { id, title, kind, executable, args, cwd, timeoutMs, risk: risk as TrustedCommand['risk'], artifacts };
    });
    return { root: path.resolve(root), commands };
  });
  return { version: 1, projects };
}

function validateArtifact(input: unknown, commandId: string, index: number): TrustedArtifact {
  if (!input || typeof input !== 'object') throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandId} artifact ${index} is invalid.`);
  const raw = input as Record<string, unknown>;
  const artifactPath = String(raw.path ?? '').trim();
  if (!artifactPath || artifactPath.length > 1000 || artifactPath.includes('\0') || artifactPath.includes('\r') || artifactPath.includes('\n') || path.isAbsolute(artifactPath)) {
    throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandId} artifact ${index} path must be a bounded relative path.`);
  }
  const normalized = path.normalize(artifactPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandId} artifact ${index} escapes the project root.`);
  }
  const kind = String(raw.kind ?? 'file');
  if (!['file', 'directory', 'json'].includes(kind)) throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandId} artifact ${index} kind is invalid.`);
  const minBytesValue = Number(raw.minBytes ?? (kind === 'directory' ? 0 : 1));
  if (!Number.isSafeInteger(minBytesValue) || minBytesValue < 0 || minBytesValue > 1024 * 1024 * 1024) {
    throw new OperatorError('COMMAND_REGISTRY_INVALID', `Command ${commandId} artifact ${index} minBytes is invalid.`);
  }
  return {
    path: artifactPath,
    kind: kind as TrustedArtifact['kind'],
    minBytes: minBytesValue,
    mustChange: raw.mustChange === true
  };
}

function validateCommandId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new OperatorError('INVALID_COMMAND_ID', 'commandId must be 1-64 safe identifier characters.');
  return value;
}

async function resolveCommandCwd(projectRoot: string, relativeCwd: string): Promise<string> {
  const absolute = path.resolve(projectRoot, relativeCwd);
  if (!isWithin(absolute, projectRoot)) throw new OperatorError('COMMAND_CWD_OUTSIDE_PROJECT', 'Registered command cwd escapes the project root.');
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) throw new OperatorError('COMMAND_CWD_INVALID', 'Registered command cwd is not an existing directory.');
  return absolute;
}

async function snapshotArtifacts(projectRoot: string, artifacts: TrustedArtifact[]): Promise<Map<string, ArtifactSnapshot>> {
  const output = new Map<string, ArtifactSnapshot>();
  for (const artifact of artifacts) output.set(artifact.path, await snapshotArtifact(projectRoot, artifact.path));
  return output;
}

async function snapshotArtifact(projectRoot: string, relativePath: string): Promise<ArtifactSnapshot> {
  const absolute = path.resolve(projectRoot, relativePath);
  if (!isWithin(absolute, projectRoot)) throw new OperatorError('ARTIFACT_PATH_OUTSIDE_PROJECT', `Artifact ${relativePath} escapes the project root.`);
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) return { path: relativePath, exists: true, type: 'symlink', size: stat.size };
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(absolute)).sort();
      const fingerprint = crypto.createHash('sha256').update(entries.join('\0')).digest('hex');
      return { path: relativePath, exists: true, type: 'directory', size: entries.length, fingerprint };
    }
    if (stat.isFile()) {
      const fingerprint = stat.size <= MAX_HASH_ARTIFACT_BYTES
        ? crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex')
        : crypto.createHash('sha256').update(`${stat.size}\0${stat.mtimeMs}`).digest('hex');
      return { path: relativePath, exists: true, type: 'file', size: stat.size, fingerprint };
    }
    return { path: relativePath, exists: true, type: 'other', size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: relativePath, exists: false };
    throw error;
  }
}

async function validateArtifacts(
  projectRoot: string,
  artifacts: TrustedArtifact[],
  before: Map<string, ArtifactSnapshot>
): Promise<ArtifactValidation[]> {
  const validations: ArtifactValidation[] = [];
  for (const artifact of artifacts) {
    const beforeSnapshot = before.get(artifact.path) ?? { path: artifact.path, exists: false };
    const after = await snapshotArtifact(projectRoot, artifact.path);
    const checks: ArtifactValidation['checks'] = [];
    checks.push({ check: 'exists', passed: after.exists, detail: after.exists ? 'Artifact exists.' : 'Artifact is missing.' });

    const expectedType = artifact.kind === 'directory' ? 'directory' : 'file';
    const typePassed = after.exists && after.type === expectedType;
    checks.push({ check: 'type', passed: typePassed, detail: typePassed
      ? `Artifact type is ${expectedType}.`
      : `Expected ${expectedType}; observed ${after.type ?? 'missing'}.` });

    if (expectedType === 'file') {
      const size = after.size ?? 0;
      checks.push({ check: 'minBytes', passed: typePassed && size >= artifact.minBytes, detail: `Observed ${size} bytes; required at least ${artifact.minBytes}.` });
    }

    if (after.type === 'symlink') {
      checks.push({ check: 'symlink', passed: false, detail: 'Artifact symlinks are not accepted for trusted validation.' });
    }

    if (artifact.mustChange) {
      const changed = after.exists && (!beforeSnapshot.exists || after.type !== beforeSnapshot.type || after.fingerprint !== beforeSnapshot.fingerprint || after.size !== beforeSnapshot.size);
      checks.push({ check: 'mustChange', passed: changed, detail: changed ? 'Artifact changed during this command run.' : 'Artifact did not change during this command run.' });
    }

    if (artifact.kind === 'json') {
      let jsonPassed = false;
      let detail = 'JSON artifact is unavailable.';
      if (after.type === 'file') {
        if ((after.size ?? 0) > MAX_JSON_ARTIFACT_BYTES) {
          detail = `JSON artifact exceeds ${MAX_JSON_ARTIFACT_BYTES} byte parse limit.`;
        } else {
          try {
            JSON.parse(await fs.readFile(path.resolve(projectRoot, artifact.path), 'utf8'));
            jsonPassed = true;
            detail = 'JSON artifact parsed successfully.';
          } catch {
            detail = 'JSON artifact is not valid JSON.';
          }
        }
      }
      checks.push({ check: 'json', passed: jsonPassed, detail });
    }

    validations.push({
      path: artifact.path,
      kind: artifact.kind,
      passed: checks.every((check) => check.passed),
      checks,
      before: beforeSnapshot,
      after
    });
  }
  return validations;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}