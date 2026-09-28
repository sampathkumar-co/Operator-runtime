import { spawn } from 'node:child_process';
import type { ActionRequest, ActionResult, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';

const SCORE: CapabilityScore = {
  reliability: 0.96,
  latency: 0.72,
  determinism: 0.98,
  security: 0.99,
  reversibility: 1,
  informationQuality: 0.96,
  interactionCost: 0.05
};

const MAX_CODE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type Language = 'javascript' | 'python';

export interface SandboxedComputeOptions {
  dockerExecutable?: string;
  images?: Partial<Record<Language, string>>;
}

export class SandboxedComputeProvider implements CapabilityProvider {
  readonly name = 'compute.docker.isolated';
  #dockerExecutable: string;
  #images: Record<Language, string>;

  constructor(options: SandboxedComputeOptions = {}) {
    this.#dockerExecutable = options.dockerExecutable ?? 'docker';
    this.#images = {
      javascript: validateImage(options.images?.javascript ?? 'node:22-alpine'),
      python: validateImage(options.images?.python ?? 'python:3.13-alpine')
    };
  }

  supports(action: ActionRequest): boolean {
    return action.capability === 'compute.run';
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    try {
      const language = String(action.input.language ?? '') as Language;
      if (language !== 'javascript' && language !== 'python') throw new OperatorError('COMPUTE_LANGUAGE_INVALID', 'compute.run language must be javascript or python.');
      const code = String(action.input.code ?? '');
      if (!code || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES || code.includes('\0')) {
        throw new OperatorError('COMPUTE_CODE_INVALID', `compute.run code must be 1-${MAX_CODE_BYTES} UTF-8 bytes without NUL.`);
      }
      const timeoutMs = boundedInteger(action.input.timeoutMs ?? 30_000, 1_000, 120_000, 'timeoutMs');
      const memoryMb = boundedInteger(action.input.memoryMb ?? 128, 32, 512, 'memoryMb');
      const cpu = boundedNumber(action.input.cpu ?? 0.5, 0.1, 2, 'cpu');
      const contextName = await localDockerContext(this.#dockerExecutable, context.signal);
      const image = this.#images[language];
      const command = language === 'javascript' ? ['node', '-'] : ['python', '-'];
      const args = [
        '--context', contextName,
        'run', '--rm', '--interactive',
        '--network', 'none',
        '--pull', 'never',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '64',
        '--memory', `${memoryMb}m`,
        '--cpus', String(cpu),
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
        '--workdir', '/tmp',
        image,
        ...command
      ];
      const output = await runDocker(this.#dockerExecutable, args, code, timeoutMs, context.signal);
      return {
        ok: output.code === 0,
        capability: action.capability,
        provider: this.name,
        output: {
          language,
          exitCode: output.code,
          stdout: output.stdout,
          stderr: output.stderr,
          truncated: output.truncated,
          isolation: {
            network: 'none',
            rootFilesystem: 'read-only',
            capabilities: 'dropped',
            privilegeEscalation: 'disabled',
            hostMounts: 'none',
            pidsLimit: 64,
            memoryMb,
            cpu
          }
        },
        evidence: [
          evidence('compute_isolation', 'pass', 'Executed code inside a no-network, read-only, no-host-mount Docker sandbox.', {
            language, image, memoryMb, cpu, pidsLimit: 64
          }),
          evidence('compute_exit', output.code === 0 ? 'pass' : 'fail', `Sandbox exited with code ${output.code}.`, {
            truncated: output.truncated
          })
        ],
        ...(output.code === 0 ? {} : {
          error: {
            code: 'COMPUTE_NONZERO_EXIT',
            message: output.stderr.trim().slice(0, 1200) || `Sandbox exited with code ${output.code}.`,
            retryable: false,
            sideEffectState: 'none' as const
          }
        }),
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError
        ? error
        : new OperatorError('COMPUTE_FAILED', error instanceof Error ? error.message : String(error), { retryable: true });
      return {
        ok: false,
        capability: action.capability,
        provider: this.name,
        evidence: [evidence('compute_isolation', 'fail', op.message, { code: op.code })],
        error: { code: op.code, message: op.message, retryable: op.retryable, sideEffectState: 'none' },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }
}

function validateImage(input: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(input) || input.includes('..')) {
    throw new OperatorError('COMPUTE_IMAGE_INVALID', 'Sandbox image reference is invalid.');
  }
  return input;
}

async function localDockerContext(executable: string, signal?: AbortSignal): Promise<string> {
  const shown = await runDocker(executable, ['context', 'show'], '', 15_000, signal);
  if (shown.code !== 0) throw new OperatorError('COMPUTE_DOCKER_UNAVAILABLE', shown.stderr.trim() || 'Docker context show failed.', { retryable: true });
  const name = shown.stdout.trim();
  if (!name || name.length > 256 || /[\r\n\0]/.test(name)) throw new OperatorError('COMPUTE_DOCKER_CONTEXT_INVALID', 'Docker returned an invalid context.');
  const inspected = await runDocker(executable, ['context', 'inspect', name, '--format', '{{json .Endpoints.docker.Host}}'], '', 15_000, signal);
  if (inspected.code !== 0) throw new OperatorError('COMPUTE_DOCKER_UNAVAILABLE', inspected.stderr.trim() || 'Docker context inspect failed.', { retryable: true });
  let host: unknown;
  try { host = JSON.parse(inspected.stdout.trim()); } catch { throw new OperatorError('COMPUTE_DOCKER_CONTEXT_INVALID', 'Docker endpoint could not be parsed.'); }
  if (typeof host !== 'string' || !isLocalDockerHost(host)) throw new OperatorError('COMPUTE_REMOTE_DOCKER_DENIED', 'Sandbox compute permits only a local Docker daemon.');
  return name;
}

function isLocalDockerHost(host: string): boolean {
  if (/^unix:\/\/\//i.test(host)) return true;
  if (/^npipe:\/\//i.test(host)) return true;
  if (/^tcp:\/\//i.test(host)) {
    try {
      const url = new URL(`http://${host.slice('tcp://'.length)}`);
      const name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return name === 'localhost' || name === '127.0.0.1' || name === '::1';
    } catch { return false; }
  }
  return false;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function runDocker(executable: string, args: string[], stdinText: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new OperatorError('EXECUTION_ABORTED', 'Sandbox compute was cancelled.')); return; }
    const env = dockerEnvironment();
    const resolved = resolveTrustedExecutable(executable, env);
    const child = spawn(resolved, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const capture = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      const slice = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      bucket.push(slice);
      bytes += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    const terminate = () => { try { child.kill('SIGKILL'); } catch {} };
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    child.stdin.end(stdinText, 'utf8');
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new OperatorError('EXECUTION_ABORTED', 'Sandbox compute was cancelled.')); return; }
      if (timedOut) { reject(new OperatorError('COMPUTE_TIMEOUT', `Sandbox exceeded ${timeoutMs}ms.`, { retryable: false })); return; }
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      });
    });
  });
}

function boundedInteger(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperatorError('COMPUTE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function boundedNumber(input: unknown, min: number, max: number, label: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < min || value > max) throw new OperatorError('COMPUTE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}
