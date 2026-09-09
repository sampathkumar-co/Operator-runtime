import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.94,
  latency: 0.88,
  determinism: 0.93,
  security: 0.96,
  reversibility: 0.96,
  informationQuality: 0.9,
  interactionCost: 0.04
};

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_EXTENSIONS = 1000;

export class VsCodeProvider implements CapabilityProvider {
  readonly name = 'vscode.cli.isolated';
  #scope: PathScope;
  #allowedRoots: string[];
  #codeExecutable: string;
  #codeArgsPrefix: string[];
  #dataDir: string;

  constructor(options: { allowedRoots: string[]; codeExecutable?: string; codeArgsPrefix?: string[]; dataDir?: string }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
    this.#codeExecutable = options.codeExecutable ?? 'code';
    this.#codeArgsPrefix = options.codeArgsPrefix ?? [];
    this.#dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.operator', 'vscode-safe'));
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'vscode.inspect' || action.capability === 'vscode.open';
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    try {
      await this.#assertDataDirOutsideProjects();
      if (action.capability === 'vscode.inspect') {
        const operation = String(action.input.operation ?? 'status');
        if (operation === 'version') {
          const result = await this.#run(['--version'], process.cwd(), 10_000);
          return ok(action, started, { operation, version: result.stdout.trim().split(/\r?\n/)[0] ?? '' }, [
            evidence('vscode_cli', 'pass', 'Read VS Code CLI version without opening a workspace.')
          ]);
        }
        if (operation === 'extensions') {
          const result = await this.#run(['--list-extensions', '--show-versions'], process.cwd(), 15_000);
          const extensions = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, MAX_EXTENSIONS).map((line) => {
            const at = line.lastIndexOf('@');
            return at > 0 ? { id: line.slice(0, at), version: line.slice(at + 1) } : { id: line };
          });
          return ok(action, started, { operation, extensions, truncated: extensions.length >= MAX_EXTENSIONS }, [
            evidence('vscode_extensions', 'pass', 'Listed installed VS Code extension identifiers and versions without opening a project.', { count: extensions.length })
          ]);
        }
        if (operation === 'status') {
          const result = await this.#run(['--status'], process.cwd(), 15_000);
          return ok(action, started, { operation, status: result.stdout.slice(0, MAX_OUTPUT_BYTES), truncated: result.truncated }, [
            evidence('vscode_status', 'pass', 'Read bounded VS Code process/status diagnostics through the official CLI.')
          ]);
        }
        throw new OperatorError('INVALID_VSCODE_INSPECT_OPERATION', 'operation must be version, extensions, or status.');
      }

      const mode = String(action.input.mode ?? 'folder');
      const timeoutMs = Math.min(Math.max(Number(action.input.timeoutMs ?? 15_000), 1_000), 60_000);
      await fs.mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      const args = ['--new-window', '--disable-extensions', `--user-data-dir=${this.#dataDir}`];
      let targetSummary: Record<string, unknown>;
      let cwd: string;

      if (mode === 'folder') {
        const folder = await this.#scope.resolveExisting(String(action.input.path ?? ''));
        const stat = await fs.stat(folder);
        if (!stat.isDirectory()) throw new OperatorError('VSCODE_FOLDER_REQUIRED', 'folder mode requires an authorized directory.');
        args.push(folder);
        cwd = folder;
        targetSummary = { mode, path: folder };
      } else if (mode === 'file' || mode === 'goto') {
        const file = await this.#scope.resolveExisting(String(action.input.path ?? ''));
        const stat = await fs.stat(file);
        if (!stat.isFile()) throw new OperatorError('VSCODE_FILE_REQUIRED', `${mode} mode requires an authorized regular file.`);
        cwd = path.dirname(file);
        if (mode === 'goto') {
          const line = boundedPositiveInt(action.input.line, 1, 1_000_000, 'line');
          const column = boundedPositiveInt(action.input.column ?? 1, 1, 1_000_000, 'column');
          args.push('--goto', `${file}:${line}:${column}`);
          targetSummary = { mode, path: file, line, column };
        } else {
          args.push(file);
          targetSummary = { mode, path: file };
        }
      } else if (mode === 'diff') {
        const left = await this.#scope.resolveExisting(String(action.input.leftPath ?? ''));
        const right = await this.#scope.resolveExisting(String(action.input.rightPath ?? ''));
        const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
        if (!leftStat.isFile() || !rightStat.isFile()) throw new OperatorError('VSCODE_DIFF_FILES_REQUIRED', 'diff mode requires two authorized regular files.');
        args.push('--diff', left, right);
        cwd = path.dirname(left);
        targetSummary = { mode, leftPath: left, rightPath: right };
      } else {
        throw new OperatorError('INVALID_VSCODE_OPEN_MODE', 'mode must be folder, file, goto, or diff.');
      }

      const result = await this.#run(args, cwd, timeoutMs);
      return ok(action, started, {
        ...targetSummary,
        isolated: true,
        extensionsDisabled: true,
        accepted: true,
        stdout: result.stdout.slice(0, 32_000),
        stderr: result.stderr.slice(0, 32_000)
      }, [
        evidence('vscode_isolation', 'pass', 'Opened target in a new Operator-isolated VS Code window with extensions disabled.', {
          userDataDir: this.#dataDir,
          reusedExistingWindow: false
        }),
        evidence('vscode_cli', 'pass', 'VS Code CLI accepted the bounded semantic open request.', { mode })
      ]);
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('VSCODE_ERROR', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('vscode', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async #assertDataDirOutsideProjects(): Promise<void> {
    const lexicalDataDir = path.resolve(this.#dataDir);
    for (const configuredRoot of this.#allowedRoots) {
      const lexicalRoot = path.resolve(configuredRoot);
      if (inside(lexicalDataDir, lexicalRoot)) {
        throw new OperatorError('VSCODE_DATA_DIR_INSIDE_PROJECT_DENIED', 'Operator VS Code user-data directory must live outside all authorized project roots.');
      }
    }
    await fs.mkdir(path.dirname(this.#dataDir), { recursive: true, mode: 0o700 });
    const parent = await fs.realpath(path.dirname(this.#dataDir));
    const resolvedDataDir = path.join(parent, path.basename(this.#dataDir));
    for (const configuredRoot of this.#allowedRoots) {
      let root = configuredRoot;
      try { root = await fs.realpath(configuredRoot); } catch { /* lexical fallback */ }
      if (inside(resolvedDataDir, root)) {
        throw new OperatorError('VSCODE_DATA_DIR_INSIDE_PROJECT_DENIED', 'Operator VS Code user-data directory must live outside all authorized project roots.');
      }
    }
  }

  async #run(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    const output = await runCode(this.#codeExecutable, [...this.#codeArgsPrefix, ...args], cwd, timeoutMs);
    if (output.code !== 0) throw new OperatorError('VSCODE_CLI_FAILED', `VS Code CLI exited with code ${output.code}.`, { details: { stderr: output.stderr.slice(-4000) } });
    return output;
  }
}

function boundedPositiveInt(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) throw new OperatorError('VSCODE_POSITION_INVALID', `${label} must be an integer between ${min} and ${max}.`);
  return value;
}

function inside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('VSCODE_')) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function runCode(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnvironment()
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const remaining = MAX_OUTPUT_BYTES - bytes;
      const piece = chunk.subarray(0, remaining);
      bucket.push(piece);
      bytes += piece.byteLength;
      if (piece.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    timer.unref();
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new OperatorError('VSCODE_TIMEOUT', `VS Code CLI exceeded ${timeoutMs}ms timeout.`, { retryable: true }));
        return;
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
    });
  });
}

function ok(action: ActionRequest, started: number, output: unknown, evidenceItems: ActionResult['evidence']): ActionResult {
  return {
    ok: true,
    capability: action.capability,
    provider: 'vscode.cli.isolated',
    output,
    evidence: evidenceItems,
    durationMs: Math.round(performance.now() - started)
  };
}
