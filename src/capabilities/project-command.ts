import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
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
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type TrustedCommand = {
  id: string;
  title?: string;
  kind?: 'build' | 'test' | 'lint' | 'format' | 'dev' | 'database' | 'custom';
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  risk: 'read' | 'write' | 'external';
};

type TrustedProject = {
  root: string;
  commands: TrustedCommand[];
};

type Registry = {
  version: 1;
  projects: TrustedProject[];
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
            registryPath: this.#registryPath,
            commands: project?.commands.map(({ id, title, kind, executable, args, cwd, timeoutMs, risk }) => ({
              id,
              title,
              kind,
              executable,
              args,
              cwd,
              timeoutMs,
              risk
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

      return {
        ...result,
        capability: action.capability,
        provider: this.name,
        output: {
          command: {
            id: command.id,
            title: command.title,
            kind: command.kind,
            executable: command.executable,
            args: command.args,
            cwd: command.cwd,
            risk: command.risk
          },
          execution: result.output
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
      const stat = await fs.stat(this.#registryPath);
      if (!stat.isFile()) throw new OperatorError('COMMAND_REGISTRY_INVALID', 'Trusted command registry path is not a regular file.');
      if (stat.size > MAX_REGISTRY_BYTES) throw new OperatorError('COMMAND_REGISTRY_TOO_LARGE', 'Trusted command registry exceeds 512 KiB.');
      raw = await fs.readFile(this.#registryPath, 'utf8');
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
    for (const project of registry.projects) {
      const canonical = await this.#scope.resolveExisting(project.root);
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
      return { id, title, kind, executable, args, cwd, timeoutMs, risk: risk as TrustedCommand['risk'] };
    });
    return { root: path.resolve(root), commands };
  });
  return { version: 1, projects };
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

function isWithin(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
