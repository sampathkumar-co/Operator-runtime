import { spawn } from 'node:child_process';
import type { ActionRequest, ActionResult, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.95,
  latency: 0.95,
  determinism: 0.94,
  security: 0.88,
  reversibility: 0.55,
  informationQuality: 0.98,
  interactionCost: 0.02
};

export class ProcessProvider implements CapabilityProvider {
  readonly name = 'process.argv';
  #scope: PathScope;
  #allowedExecutables: Set<string>;
  #maxOutputBytes: number;

  constructor(options: { allowedRoots: string[]; allowedExecutables: string[]; maxOutputBytes?: number }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedExecutables = new Set(options.allowedExecutables.map((item) => item.toLowerCase()));
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  supports(action: ActionRequest): boolean { return action.capability === 'terminal.execute'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    const executable = String(action.input.executable ?? '');
    const args = Array.isArray(action.input.args) ? action.input.args.map(String) : [];
    const cwd = await this.#scope.resolveExisting(String(action.input.cwd ?? ''));
    const timeoutMs = Math.min(Math.max(Number(action.input.timeoutMs ?? 30_000), 100), 10 * 60_000);

    if (!this.#allowedExecutables.has(executable.toLowerCase())) {
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('process_policy', 'fail', `Executable ${executable} is not allowlisted.`)],
        error: { code: 'EXECUTABLE_DENIED', message: `Executable ${executable} is not allowlisted.`, retryable: false },
        durationMs: Math.round(performance.now() - started)
      };
    }

    try {
      const output = await runProcess(executable, args, cwd, timeoutMs, this.#maxOutputBytes);
      const ok = output.exitCode === 0;
      return {
        ok,
        capability: action.capability,
        provider: this.name,
        output,
        evidence: [
          evidence('process_exit', ok ? 'pass' : 'fail', `Process exited with code ${output.exitCode}.`, { exitCode: output.exitCode, signal: output.signal }),
          evidence('process_invocation', 'info', 'Process executed without a command shell.', { executable, args, cwd, timeoutMs })
        ],
        error: ok ? undefined : { code: 'NONZERO_EXIT', message: `Process exited with code ${output.exitCode}.`, retryable: false },
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('PROCESS_ERROR', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('process', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }
}

async function runProcess(executable: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= maxOutputBytes) { truncated = true; return; }
      const remaining = maxOutputBytes - bytes;
      const sliced = chunk.subarray(0, remaining);
      bucket.push(sliced);
      bytes += sliced.byteLength;
      if (sliced.byteLength < chunk.byteLength) truncated = true;
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

    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new OperatorError('PROCESS_TIMEOUT', `Process exceeded ${timeoutMs}ms timeout.`, { retryable: true }));
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      });
    });
  });
}
