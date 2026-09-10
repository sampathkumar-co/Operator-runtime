import { spawn } from 'node:child_process';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { PathScope } from './path-scope.ts';

const SCORE: CapabilityScore = {
  reliability: 0.95,
  latency: 0.95,
  determinism: 0.94,
  security: 0.9,
  reversibility: 0.55,
  informationQuality: 0.98,
  interactionCost: 0.02
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ARGS = 200;
const MAX_ARG_BYTES = 16 * 1024;

// Child processes receive only environment needed for ordinary executable lookup,
// user directories, temporary files and locale handling. Ambient credentials,
// runtime injection flags (NODE_OPTIONS, PYTHONPATH, GIT_*), proxies and all
// OPERATOR_* authority remain in the local-agent process only.
const SAFE_ENV_KEYS = new Set([
  'PATH', 'PATHEXT',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
  'LOCALAPPDATA', 'APPDATA'
]);

export class ProcessProvider implements CapabilityProvider {
  readonly name = 'process.argv';
  #scope: PathScope;
  #allowedExecutables: Set<string>;
  #maxOutputBytes: number;
  #requiredRisk?: ActionRisk;

  constructor(options: {
    allowedRoots: string[];
    allowedExecutables: string[];
    maxOutputBytes?: number;
    requiredRisk?: ActionRisk;
  }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedExecutables = new Set(options.allowedExecutables.map((item) => item.trim().toLowerCase()).filter(Boolean));
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
    this.#requiredRisk = options.requiredRisk;
  }

  supports(action: ActionRequest): boolean { return action.capability === 'terminal.execute'; }
  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest): Promise<ActionResult> {
    const started = performance.now();
    const executable = String(action.input.executable ?? '').trim();
    const args = Array.isArray(action.input.args) ? action.input.args.map(String) : [];
    const timeoutMs = boundedInteger(action.input.timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);

    if (this.#requiredRisk && action.risk !== this.#requiredRisk) {
      return failure(action, this.name, started, 'PROCESS_RISK_MISMATCH', `Process execution requires ${this.#requiredRisk} risk classification.`);
    }
    if (!executable || executable.includes('\0')) {
      return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', 'Executable must be a non-empty string without NUL bytes.');
    }
    if (args.length > MAX_ARGS || args.some((arg) => arg.includes('\0') || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES)) {
      return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', `Process arguments are limited to ${MAX_ARGS} entries and ${MAX_ARG_BYTES} UTF-8 bytes each.`);
    }
    if (!this.#allowedExecutables.has(executable.toLowerCase())) {
      return failure(action, this.name, started, 'EXECUTABLE_DENIED', `Executable ${executable} is not allowlisted.`);
    }

    try {
      const cwd = await this.#scope.resolveExisting(String(action.input.cwd ?? ''));
      const output = await runProcess(executable, args, cwd, timeoutMs, this.#maxOutputBytes);
      const ok = output.exitCode === 0;
      return {
        ok,
        capability: action.capability,
        provider: this.name,
        output,
        evidence: [
          evidence('process_exit', ok ? 'pass' : 'fail', `Process exited with code ${output.exitCode}.`, { exitCode: output.exitCode, signal: output.signal }),
          evidence('process_invocation', 'info', 'Process executed shell-free with a bounded, credential-scrubbed environment.', {
            executable,
            argCount: args.length,
            cwd,
            timeoutMs,
            outputLimitBytes: this.#maxOutputBytes
          })
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

function failure(action: ActionRequest, provider: string, started: number, code: string, message: string): ActionResult {
  return {
    ok: false,
    capability: action.capability,
    provider,
    evidence: [evidence('process_policy', 'fail', message, { code })],
    error: { code, message, retryable: false },
    durationMs: Math.round(performance.now() - started)
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!SAFE_ENV_KEYS.has(key.toUpperCase())) continue;
    safe[key] = value;
  }
  return safe;
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
      env: safeChildEnvironment()
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
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
    child.once('error', rejectOnce);

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* close/error path reports the outcome */ }
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      }, 1000);
      forceKillTimer.unref();
    }, timeoutMs);
    timer.unref();

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
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
