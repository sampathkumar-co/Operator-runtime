import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, CapabilityProvider, CapabilityScore } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';
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
const MAX_SESSIONS = 32;
const MAX_SESSION_EVENTS = 2000;
const MAX_SESSION_INPUT_BYTES = 64 * 1024;
const MAX_SESSION_IDLE_MS = 60 * 60_000;
const MAX_PROCESS_INSPECT_RESULTS = 500;

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

type SessionEvent = { cursor: number; stream: 'stdout' | 'stderr' | 'system'; text: string; at: string };
type ManagedSession = {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  pid: number;
  startedAt: string;
  updatedAt: string;
  state: 'running' | 'exited' | 'terminated' | 'failed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  events: SessionEvent[];
  nextCursor: number;
  droppedBeforeCursor: number;
  bufferedBytes: number;
};

export class ProcessProvider implements CapabilityProvider {
  readonly name = 'process.argv';
  #scope: PathScope;
  #allowedExecutables: Set<string>;
  #maxOutputBytes: number;
  #requiredRisk?: ActionRisk;
  #environmentOverrides: Readonly<Record<string, string>>;
  #sessions = new Map<string, ManagedSession>();

  constructor(options: {
    allowedRoots: string[];
    allowedExecutables: string[];
    maxOutputBytes?: number;
    requiredRisk?: ActionRisk;
    environmentOverrides?: Readonly<Record<string, string>>;
  }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedExecutables = new Set(options.allowedExecutables.map((item) => item.trim().toLowerCase()).filter(Boolean));
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
    this.#requiredRisk = options.requiredRisk;
    this.#environmentOverrides = validateEnvironmentOverrides(options.environmentOverrides);
  }

  supports(action: ActionRequest): boolean {
    return ['terminal.execute', 'terminal.session', 'process.inspect', 'process.manage'].includes(action.capability);
  }

  resolveRisk(action: ActionRequest): ActionRisk {
    if (action.capability !== 'terminal.session') throw new OperatorError('CAPABILITY_RISK_UNRESOLVED', 'Process dynamic risk applies only to terminal.session.');
    const operation = String(action.input.operation ?? '');
    if (operation === 'list' || operation === 'read') return 'read';
    if (['start', 'write', 'terminate'].includes(operation)) return 'destructive';
    throw new OperatorError('PROCESS_INPUT_INVALID', 'terminal.session operation must be start, list, read, write, or terminate.');
  }

  score(): CapabilityScore { return SCORE; }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    if (action.capability === 'terminal.session') return await this.#session(action, started);
    if (action.capability === 'process.inspect') return await this.#inspectProcesses(action, started, context.signal);
    if (action.capability === 'process.manage') return await this.#manageProcess(action, started, context.signal);
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
      const output = await runProcess(executable, args, cwd, timeoutMs, this.#maxOutputBytes, this.#environmentOverrides, context.signal);
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

  async #session(action: ActionRequest, started: number): Promise<ActionResult> {
    this.#pruneSessions();
    const operation = String(action.input.operation ?? '');
    if (operation === 'start') {
      if (this.#sessions.size >= MAX_SESSIONS) return failure(action, this.name, started, 'SESSION_LIMIT_REACHED', `At most ${MAX_SESSIONS} managed terminal sessions may exist.`);
      const executable = String(action.input.executable ?? '').trim();
      const args = Array.isArray(action.input.args) ? action.input.args.map(String) : [];
      const validation = this.#validateInvocation(executable, args);
      if (validation) return failure(action, this.name, started, validation.code, validation.message);
      try {
        const cwd = await this.#scope.resolveExisting(String(action.input.cwd ?? ''));
        const env = safeChildEnvironment(process.env, this.#environmentOverrides);
        const trustedExecutable = resolveTrustedExecutable(executable, env);
        const child = spawn(trustedExecutable, args, {
          cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env
        }) as ChildProcessWithoutNullStreams;
        if (!child.pid) throw new OperatorError('PROCESS_START_FAILED', 'Process did not return a PID.');
        const session: ManagedSession = {
          id: crypto.randomUUID(), executable, args: [...args], cwd, child, pid: child.pid,
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          state: 'running', exitCode: null, signal: null, events: [], nextCursor: 1,
          droppedBeforeCursor: 0, bufferedBytes: 0
        };
        this.#sessions.set(session.id, session);
        this.#appendSessionEvent(session, 'system', `process started pid=${session.pid}`);
        child.stdout.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stdout', chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stderr', chunk.toString('utf8')));
        child.once('error', (error) => {
          session.state = 'failed'; session.updatedAt = new Date().toISOString();
          this.#appendSessionEvent(session, 'system', `process error: ${error.message}`);
        });
        child.once('close', (code, signal) => {
          session.exitCode = code; session.signal = signal;
          if (session.state === 'running') session.state = 'exited';
          session.updatedAt = new Date().toISOString();
          this.#appendSessionEvent(session, 'system', `process exited code=${String(code)} signal=${String(signal ?? '')}`);
        });
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: this.#sessionSummary(session),
          evidence: [evidence('process_session', 'pass', 'Managed shell-free terminal session started.', { sessionId: session.id, pid: session.pid, executable, cwd })],
          durationMs: Math.round(performance.now() - started)
        };
      } catch (error) {
        const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_START_FAILED', error instanceof Error ? error.message : String(error));
        return failure(action, this.name, started, op.code, op.message);
      }
    }

    if (operation === 'list') {
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { sessions: [...this.#sessions.values()].map((session) => this.#sessionSummary(session)) },
        evidence: [evidence('process_session', 'pass', 'Managed terminal sessions listed.', { count: this.#sessions.size })],
        durationMs: Math.round(performance.now() - started)
      };
    }

    const sessionId = requiredSessionId(action.input.sessionId);
    const session = this.#sessions.get(sessionId);
    if (!session) return failure(action, this.name, started, 'SESSION_NOT_FOUND', 'Managed terminal session was not found.');

    if (operation === 'read') {
      const afterCursor = boundedInteger(action.input.afterCursor, 0, 0, Number.MAX_SAFE_INTEGER);
      const maxEvents = boundedInteger(action.input.maxEvents, 100, 1, 500);
      const maxBytes = boundedInteger(action.input.maxBytes, 256 * 1024, 1024, 2 * 1024 * 1024);
      const events: SessionEvent[] = [];
      let bytes = 0;
      for (const event of session.events) {
        if (event.cursor <= afterCursor) continue;
        const size = Buffer.byteLength(event.text, 'utf8');
        if (events.length >= maxEvents || bytes + size > maxBytes) break;
        events.push(event); bytes += size;
      }
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: {
          ...this.#sessionSummary(session),
          events,
          cursor: events.at(-1)?.cursor ?? afterCursor,
          droppedBeforeCursor: session.droppedBeforeCursor,
          truncatedBefore: afterCursor < session.droppedBeforeCursor
        },
        evidence: [evidence('process_session_read', 'pass', 'Bounded terminal session output read by cursor.', { sessionId, eventCount: events.length, bytes })],
        durationMs: Math.round(performance.now() - started)
      };
    }

    if (operation === 'write') {
      if (session.state !== 'running' || session.child.stdin.destroyed) return failure(action, this.name, started, 'SESSION_NOT_RUNNING', 'Managed terminal session is not accepting input.');
      const input = String(action.input.input ?? '');
      if (!input || input.includes('\0') || Buffer.byteLength(input, 'utf8') > MAX_SESSION_INPUT_BYTES) {
        return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', `Session input must contain 1-${MAX_SESSION_INPUT_BYTES} UTF-8 bytes and no NUL.`);
      }
      await new Promise<void>((resolve, reject) => session.child.stdin.write(input, (error) => error ? reject(error) : resolve()));
      session.updatedAt = new Date().toISOString();
      this.#appendSessionEvent(session, 'system', `stdin write bytes=${Buffer.byteLength(input, 'utf8')}`);
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { ...this.#sessionSummary(session), writtenBytes: Buffer.byteLength(input, 'utf8') },
        evidence: [evidence('process_session_write', 'pass', 'Input written to managed terminal session.', { sessionId, bytes: Buffer.byteLength(input, 'utf8') })],
        durationMs: Math.round(performance.now() - started)
      };
    }

    if (operation === 'terminate') {
      if (session.state === 'running') {
        await terminateProcessTree(session.child, session.pid);
        session.state = 'terminated';
        session.updatedAt = new Date().toISOString();
        this.#appendSessionEvent(session, 'system', 'termination requested');
      }
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: this.#sessionSummary(session),
        evidence: [evidence('process_session_terminate', 'pass', 'Managed terminal session termination requested for its owned process tree.', { sessionId, pid: session.pid })],
        durationMs: Math.round(performance.now() - started)
      };
    }
    return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', 'terminal.session operation must be start, list, read, write, or terminate.');
  }

  async #inspectProcesses(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    if (process.platform !== 'win32') return failure(action, this.name, started, 'WINDOWS_ONLY', 'System process inspection is currently certified only on Windows.');
    try {
      const limit = boundedInteger(action.input.limit, 200, 1, MAX_PROCESS_INSPECT_RESULTS);
      const nameFilter = typeof action.input.name === 'string' ? action.input.name.trim().toLowerCase() : '';
      const pidFilter = action.input.pid === undefined ? undefined : boundedInteger(action.input.pid, 0, 1, 0x7fff_ffff);
      const rows = await runTasklist(signal);
      const processes = rows
        .filter((row) => (pidFilter === undefined || row.pid === pidFilter) && (!nameFilter || row.imageName.toLowerCase().includes(nameFilter)))
        .slice(0, limit);
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { processes, truncated: rows.length > processes.length && processes.length >= limit },
        evidence: [evidence('process_inspect', 'pass', 'Windows process table inspected through tasklist without command lines or environment data.', { count: processes.length })],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_INSPECT_FAILED', error instanceof Error ? error.message : String(error));
      return failure(action, this.name, started, op.code, op.message);
    }
  }

  async #manageProcess(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    if (process.platform !== 'win32') return failure(action, this.name, started, 'WINDOWS_ONLY', 'System process management is currently certified only on Windows.');
    if (String(action.input.operation ?? '') !== 'terminate') return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', 'process.manage currently supports only terminate.');
    const pid = boundedInteger(action.input.pid, 0, 1, 0x7fff_ffff);
    const expectedFingerprint = String(action.input.expectedFingerprint ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) return failure(action, this.name, started, 'PROCESS_PRECONDITION_REQUIRED', 'process.manage terminate requires expectedFingerprint from a fresh process.inspect.');
    if (pid === process.pid || pid <= 4) return failure(action, this.name, started, 'PROCESS_TERMINATE_DENIED', 'Refusing to terminate the Operator process or reserved system PIDs.');
    try {
      const processes = await runTasklist(signal);
      const target = processes.find((entry) => entry.pid === pid);
      if (!target) return failure(action, this.name, started, 'PROCESS_NOT_FOUND', 'Process no longer exists.');
      if (target.fingerprint !== expectedFingerprint) return failure(action, this.name, started, 'PROCESS_PRECONDITION_FAILED', 'Process identity changed since inspection.');
      if (!sameWindowsUser(target.userName, os.userInfo().username)) return failure(action, this.name, started, 'PROCESS_TERMINATE_DENIED', 'Refusing to terminate a process owned by another Windows account.');
      if (CRITICAL_WINDOWS_PROCESSES.has(target.imageName.toLowerCase())) return failure(action, this.name, started, 'PROCESS_TERMINATE_DENIED', 'Refusing to terminate a critical Windows process.');
      await runTaskkill(pid, signal);
      const remaining = (await runTasklist(signal)).some((entry) => entry.pid === pid && entry.fingerprint === expectedFingerprint);
      if (remaining) throw new OperatorError('PROCESS_TERMINATE_POSTCONDITION_FAILED', 'Target process remained after taskkill completed.');
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { operation: 'terminate', pid, imageName: target.imageName, fingerprint: target.fingerprint },
        evidence: [
          evidence('process_terminate', 'pass', 'Freshly fingerprinted current-user Windows process tree terminated.', { pid, imageName: target.imageName }),
          evidence('postcondition', 'pass', 'The inspected process identity is no longer present.', { pid, fingerprint: target.fingerprint })
        ],
        durationMs: Math.round(performance.now() - started)
      };
    } catch (error) {
      const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_TERMINATE_FAILED', error instanceof Error ? error.message : String(error));
      return failure(action, this.name, started, op.code, op.message);
    }
  }

  #validateInvocation(executable: string, args: string[]): { code: string; message: string } | undefined {
    if (!executable || executable.includes('\0')) return { code: 'PROCESS_INPUT_INVALID', message: 'Executable must be a non-empty string without NUL bytes.' };
    if (args.length > MAX_ARGS || args.some((arg) => arg.includes('\0') || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES)) {
      return { code: 'PROCESS_INPUT_INVALID', message: `Process arguments are limited to ${MAX_ARGS} entries and ${MAX_ARG_BYTES} UTF-8 bytes each.` };
    }
    if (!this.#allowedExecutables.has(executable.toLowerCase())) return { code: 'EXECUTABLE_DENIED', message: `Executable ${executable} is not allowlisted.` };
    return undefined;
  }

  #appendSessionEvent(session: ManagedSession, stream: SessionEvent['stream'], text: string): void {
    if (!text) return;
    const event: SessionEvent = { cursor: session.nextCursor++, stream, text, at: new Date().toISOString() };
    session.events.push(event);
    session.bufferedBytes += Buffer.byteLength(text, 'utf8');
    session.updatedAt = event.at;
    while (session.events.length > MAX_SESSION_EVENTS || session.bufferedBytes > this.#maxOutputBytes) {
      const removed = session.events.shift();
      if (!removed) break;
      session.bufferedBytes -= Buffer.byteLength(removed.text, 'utf8');
      session.droppedBeforeCursor = removed.cursor;
    }
  }

  #sessionSummary(session: ManagedSession): Record<string, unknown> {
    return {
      sessionId: session.id, pid: session.pid, executable: session.executable, cwd: session.cwd,
      argCount: session.args.length, state: session.state, startedAt: session.startedAt, updatedAt: session.updatedAt,
      exitCode: session.exitCode, signal: session.signal, nextCursor: session.nextCursor,
      droppedBeforeCursor: session.droppedBeforeCursor
    };
  }

  #pruneSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      const age = now - Date.parse(session.updatedAt);
      if (session.state !== 'running' && age > MAX_SESSION_IDLE_MS) this.#sessions.delete(id);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.values()].filter((session) => session.state === 'running').map(async (session) => {
      await terminateProcessTree(session.child, session.pid);
      session.state = 'terminated';
    }));
    this.#sessions.clear();
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

function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env, overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!SAFE_ENV_KEYS.has(key.toUpperCase())) continue;
    safe[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) safe[key] = value;
  return safe;
}

function validateEnvironmentOverrides(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.includes('\0')) {
      throw new OperatorError('PROCESS_ENV_OVERRIDE_INVALID', 'Trusted process environment override is invalid.');
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

async function runProcess(executable: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number, environmentOverrides: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperatorError('EXECUTION_ABORTED', 'Process execution was cancelled.', { retryable: false }));
      return;
    }
    const childEnvironment = safeChildEnvironment(process.env, environmentOverrides);
    const trustedExecutable = resolveTrustedExecutable(executable, childEnvironment);
    const child = spawn(trustedExecutable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
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

    const terminateChild = () => {
      try { child.kill('SIGTERM'); } catch { /* close/error path reports the outcome */ }
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
        }, 1000);
        forceKillTimer.unref();
      }
    };
    const onAbort = () => {
      aborted = true;
      terminateChild();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    timer.unref();

    child.once('close', (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'Process execution was cancelled.', { retryable: false }));
        return;
      }
      if (timedOut) {
        reject(new OperatorError('PROCESS_TIMEOUT', `Process exceeded ${timeoutMs}ms timeout.`, { retryable: true }));
        return;
      }
      resolve({
        exitCode,
        signal: closeSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      });
    });
  });
}


function requiredSessionId(value: unknown): string {
  const sessionId = String(value ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new OperatorError('PROCESS_INPUT_INVALID', 'sessionId must be a UUID created by terminal.session start.');
  }
  return sessionId;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    await new Promise<void>((resolve) => {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { try { child.kill(); } catch {} resolve(); });
      killer.once('close', () => resolve());
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
}

const CRITICAL_WINDOWS_PROCESSES = new Set([
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'winlogon.exe', 'fontdrvhost.exe'
]);

type WindowsProcessRow = {
  imageName: string; pid: number; sessionName: string; sessionNumber: number; memoryKb: number;
  status: string; userName: string; cpuTime: string; windowTitle: string; fingerprint: string;
};

async function runTasklist(signal?: AbortSignal): Promise<WindowsProcessRow[]> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
  const output = await runProcess(executable, ['/V', '/FO', 'CSV', '/NH'], process.cwd(), 15_000, 8 * 1024 * 1024, {}, signal);
  if (output.exitCode !== 0) throw new OperatorError('PROCESS_INSPECT_FAILED', `tasklist exited with ${String(output.exitCode)}.`);
  const rows: WindowsProcessRow[] = [];
  for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
    const cols = parseCsvLine(line);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const sessionNumber = Number(cols[3]);
    const memoryKb = Number(String(cols[4]).replace(/[^0-9]/g, ''));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const imageName = cols[0]!;
    const sessionName = cols[2] ?? '';
    const status = cols[5] ?? '';
    const userName = cols[6] ?? '';
    const cpuTime = cols[7] ?? '';
    const windowTitle = cols.slice(8).join(',');
    const fingerprint = crypto.createHash('sha256')
      .update(imageName.toLowerCase()).update('\0')
      .update(String(pid)).update('\0')
      .update(sessionName.toLowerCase()).update('\0')
      .update(String(Number.isFinite(sessionNumber) ? sessionNumber : 0)).update('\0')
      .update(userName.toLowerCase())
      .digest('hex');
    rows.push({
      imageName, pid, sessionName,
      sessionNumber: Number.isFinite(sessionNumber) ? sessionNumber : 0,
      memoryKb: Number.isFinite(memoryKb) ? memoryKb : 0,
      status, userName, cpuTime, windowTitle, fingerprint
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current); current = '';
    } else current += char;
  }
  values.push(current);
  return values;
}


function sameWindowsUser(tasklistUser: string, currentUser: string): boolean {
  const left = tasklistUser.trim().toLowerCase();
  const right = currentUser.trim().toLowerCase();
  return left === right || left.endsWith('\\' + right);
}

async function runTaskkill(pid: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Process termination was cancelled.', { retryable: false });
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'taskkill.exe');
  const output = await runProcess(executable, ['/PID', String(pid), '/T', '/F'], process.cwd(), 20_000, 512 * 1024, {}, signal);
  if (output.exitCode !== 0) throw new OperatorError('PROCESS_TERMINATE_FAILED', `taskkill exited with ${String(output.exitCode)}.`);
}
