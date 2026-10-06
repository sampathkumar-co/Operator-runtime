import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';
import { inspectProcessInstance, sameProcessInstance, type ProcessInstanceIdentity } from '../core/process-instance.ts';
import { DeveloperSessionStore } from '../core/developer-session.ts';
import { DeveloperRuntimeOwnershipStore, type DeveloperRuntimeOwnershipRecord } from '../core/developer-runtime-ownership.ts';
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
  developerSessionId?: string;
  processInstance?: ProcessInstanceIdentity;
  ports: number[];
  ownsProcessGroup: boolean;
};

export class ProcessProvider implements CapabilityProvider {
  readonly name = 'process.argv';
  #scope: PathScope;
  #allowedExecutables: Set<string>;
  #maxOutputBytes: number;
  #requiredRisk?: ActionRisk;
  #environmentOverrides: Readonly<Record<string, string>>;
  #sessions = new Map<string, ManagedSession>();
  #ownership?: DeveloperRuntimeOwnershipStore;
  #developerSessions?: DeveloperSessionStore;
  #ownershipRecovered?: Promise<void>;

  constructor(options: {
    allowedRoots: string[];
    allowedExecutables: string[];
    maxOutputBytes?: number;
    requiredRisk?: ActionRisk;
    environmentOverrides?: Readonly<Record<string, string>>;
    stateDir?: string;
  }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedExecutables = new Set(options.allowedExecutables.map((item) => item.trim().toLowerCase()).filter(Boolean));
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
    this.#requiredRisk = options.requiredRisk;
    this.#environmentOverrides = validateEnvironmentOverrides(options.environmentOverrides);
    if (options.stateDir) {
      this.#ownership = new DeveloperRuntimeOwnershipStore(options.stateDir);
      this.#developerSessions = new DeveloperSessionStore(options.stateDir);
    }
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
    if (action.capability === 'terminal.session') return await this.#session(action, started, context);
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
        error: {
          code: op.code, message: op.message, retryable: op.retryable,
          sideEffectState: action.risk === 'read' ? 'none' : processFailureSideEffectState(op),
          ...(op.details ? { details: structuredClone(op.details) } : {})
        },
        durationMs: Math.round(performance.now() - started)
      };
    }
  }

  async reconcile(
    request: ProviderReconciliationRequest,
    context: CapabilityExecutionContext = {}
  ): Promise<ProviderReconciliationResult> {
    const action = request.action;
    if (action.capability === 'process.manage' && String(action.input.operation ?? '') === 'terminate') {
      if (process.platform !== 'win32') return processReconciliation('uncertain', 'Process reconciliation is certified only on Windows.');
      const pid = boundedInteger(action.input.pid, 0, 1, 0x7fff_ffff);
      const expectedFingerprint = String(action.input.expectedFingerprint ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
        return processReconciliation('uncertain', 'Process termination reconciliation requires the original fingerprint.');
      }
      try {
        const rows = await runTasklistVerbose(context.signal, pid);
        const exact = rows.find((entry) => entry.pid === pid && entry.fingerprint === expectedFingerprint);
        if (exact) return processReconciliation('not_applied', 'The exact inspected process identity is still present.');
        return processReconciled(action, this.name, 'The exact inspected process identity is no longer present.', {
          operation: 'terminate',
          pid,
          fingerprint: expectedFingerprint
        });
      } catch (error) {
        return processReconciliation('uncertain', error instanceof Error ? error.message : 'Process reconciliation failed.');
      }
    }

    if (action.capability === 'terminal.session' && String(action.input.operation ?? '') === 'terminate') {
      let sessionId: string;
      try { sessionId = requiredSessionId(action.input.sessionId); }
      catch { return processReconciliation('uncertain', 'Managed-session termination reconciliation requires a valid sessionId.'); }

      await this.#ensureOwnershipRecovered();
      const session = this.#sessions.get(sessionId);
      if (session) {
        if (session.state === 'running') {
          return processReconciliation('not_applied', 'Managed session is still running.');
        }
        return processReconciled(action, this.name, 'Managed session is no longer running.', this.#sessionSummary(session));
      }

      if (this.#ownership) {
        try {
          const owned = await this.#ownership.get(sessionId);
          if (owned.phase === 'RUNNING' || owned.phase === 'TERMINATION_PENDING') {
            return processReconciliation(
              'not_applied',
              'Exact durably owned process instance is still present after provider restart.'
            );
          }
          if (owned.phase === 'EXITED' || owned.phase === 'TERMINATED') {
            return processReconciled(
              action,
              this.name,
              'Durable ownership proves the exact process instance is no longer running.',
              this.#ownedRecordSummary(owned)
            );
          }
          return processReconciliation(
            'uncertain',
            'Durable launch ownership is ambiguous and cannot prove termination.'
          );
        } catch (error) {
          if ((error as { code?: string }).code !== 'DEVELOPER_RUNTIME_SESSION_NOT_FOUND') {
            return processReconciliation(
              'uncertain',
              error instanceof Error ? error.message : 'Durable session reconciliation failed.'
            );
          }
        }
      }
      return processReconciliation('uncertain', 'Managed session has no durable restart ownership record.');
    }

    return processReconciliation('uncertain', 'Process provider cannot prove the outcome of this mutation from current state.');
  }

  async #session(action: ActionRequest, started: number, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    this.#pruneSessions();
    await this.#ensureOwnershipRecovered();
    if (context.signal?.aborted) return failure(action, this.name, started, 'EXECUTION_ABORTED', 'Terminal session operation was cancelled before dispatch.');
    const operation = String(action.input.operation ?? '');
    if (operation === 'start') {
      if (this.#sessions.size >= MAX_SESSIONS) {
        return failure(action, this.name, started, 'SESSION_LIMIT_REACHED', 'Managed terminal session limit reached.');
      }
      const executable = String(action.input.executable ?? '').trim();
      const args = Array.isArray(action.input.args) ? action.input.args.map(String) : [];
      const validation = this.#validateInvocation(executable, args);
      if (validation) return failure(action, this.name, started, validation.code, validation.message);

      const developerSessionId = action.input.developerSessionId === undefined
        ? undefined
        : String(action.input.developerSessionId);
      const ports = normalizeDeclaredPorts(action.input.ports);
      if (ports.length > 0 && !developerSessionId) {
        return failure(
          action,
          this.name,
          started,
          'DEVELOPER_RUNTIME_SESSION_REQUIRED',
          'Declared ports require developerSessionId so ownership can survive restart.'
        );
      }
      if (developerSessionId && (!this.#ownership || !this.#developerSessions)) {
        return failure(
          action,
          this.name,
          started,
          'DEVELOPER_RUNTIME_STATE_REQUIRED',
          'Developer Session-bound terminal processes require durable stateDir.'
        );
      }

      const sessionId = crypto.randomUUID();
      let launchIntent = false;
      let ownershipCommitted = false;
      let child: ChildProcessWithoutNullStreams | undefined;
      let processInstance: ProcessInstanceIdentity | null | undefined;
      const ownsProcessGroup = process.platform !== 'win32';

      try {
        if (developerSessionId) {
          const developerSession = await this.#developerSessions!.get(developerSessionId);
          if (!['ACTIVE', 'VERIFYING'].includes(developerSession.status)) {
            throw new OperatorError(
              'DEVELOPER_SESSION_NOT_EXECUTABLE',
              'Developer Session must be ACTIVE or VERIFYING before it can own a process.',
              { details: { developerSessionId, status: developerSession.status } }
            );
          }
          await this.#ownership!.beginLaunch({
            processSessionId: sessionId,
            developerSessionId,
            ports
          });
          launchIntent = true;
        }

        const cwd = await this.#scope.resolveExisting(String(action.input.cwd ?? ''));
        const env = safeChildEnvironment(process.env, this.#environmentOverrides);
        const trustedExecutable = resolveTrustedExecutable(executable, env);
        child = spawn(trustedExecutable, args, {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          detached: ownsProcessGroup
        }) as ChildProcessWithoutNullStreams;
        if (!child.pid) throw new OperatorError('PROCESS_START_FAILED', 'Process did not return a PID.');

        if (developerSessionId) {
          processInstance = await waitForProcessInstance(child.pid, context.signal);
          if (!processInstance) {
            try {
              await terminateProcessTree(child, child.pid, undefined, ownsProcessGroup);
              await this.#ownership!.abortLaunch(sessionId);
              launchIntent = false;
            } catch {
              // Keep the launch intent durable. Restart recovery will promote
              // it to AMBIGUOUS rather than pretending no process escaped.
            }
            throw new OperatorError(
              'PROCESS_INSTANCE_IDENTITY_UNAVAILABLE',
              'Started process could not be bound to an exact OS process instance.',
              { details: { sideEffectState: launchIntent ? 'uncertain' : 'none' } }
            );
          }
          await this.#ownership!.commitLaunch(sessionId, processInstance);
          ownershipCommitted = true;
        }

        const now = new Date().toISOString();
        const session: ManagedSession = {
          id: sessionId,
          executable,
          args: [...args],
          cwd,
          child,
          pid: child.pid,
          startedAt: now,
          updatedAt: now,
          state: 'running',
          exitCode: null,
          signal: null,
          events: [],
          nextCursor: 1,
          droppedBeforeCursor: 0,
          bufferedBytes: 0,
          ...(developerSessionId ? { developerSessionId } : {}),
          ...(processInstance ? { processInstance } : {}),
          ports,
          ownsProcessGroup
        };
        this.#sessions.set(session.id, session);
        this.#appendSessionEvent(session, 'system', 'process started pid=' + String(session.pid));
        child.stdout.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stdout', chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stderr', chunk.toString('utf8')));
        child.once('error', (error) => {
          session.state = 'failed';
          session.updatedAt = new Date().toISOString();
          this.#appendSessionEvent(session, 'system', 'process error: ' + error.message);
        });
        child.once('close', (code, closeSignal) => {
          session.exitCode = code;
          session.signal = closeSignal;
          if (session.state === 'running') session.state = 'exited';
          session.updatedAt = new Date().toISOString();
          this.#appendSessionEvent(
            session,
            'system',
            'process exited code=' + String(code) + ' signal=' + String(closeSignal ?? '')
          );
          if (session.processInstance && this.#ownership) {
            void this.#ownership.markExited(session.id, session.processInstance, session.updatedAt).catch(() => undefined);
          }
        });

        if (context.signal?.aborted) {
          await terminateProcessTree(child, session.pid, undefined, ownsProcessGroup);
          session.state = 'terminated';
          if (session.processInstance && this.#ownership) {
            await this.#ownership.markTerminated(session.id, session.processInstance);
          }
          return failure(
            action,
            this.name,
            started,
            new OperatorError(
              'EXECUTION_ABORTED',
              'Terminal session start was cancelled after process creation; the owned process tree was quiesced.',
              { details: { sideEffectState: 'known' } }
            )
          );
        }

        return {
          ok: true,
          capability: action.capability,
          provider: this.name,
          output: this.#sessionSummary(session),
          evidence: [
            evidence(
              'process_session',
              'pass',
              developerSessionId
                ? 'Durably owned Developer Session process started with exact process-instance identity.'
                : 'Managed shell-free terminal session started.',
              {
                sessionId: session.id,
                pid: session.pid,
                executable,
                cwd,
                durableOwned: Boolean(developerSessionId),
                portCount: ports.length
              }
            )
          ],
          durationMs: Math.round(performance.now() - started)
        };
      } catch (error) {
        if (launchIntent && !ownershipCommitted && this.#ownership) {
          if (!child?.pid || !processAlive(child.pid)) {
            await this.#ownership.abortLaunch(sessionId).catch(() => undefined);
          } else {
            try {
              await terminateProcessTree(child, child.pid, undefined, ownsProcessGroup);
              await this.#ownership.abortLaunch(sessionId);
            } catch {
              // Preserve the launch intent for fail-closed recovery.
            }
          }
        }
        const op = error instanceof OperatorError
          ? error
          : new OperatorError('PROCESS_START_FAILED', error instanceof Error ? error.message : String(error));
        return failure(action, this.name, started, op);
      }
    }

    if (operation === 'list') {
      const developerSessionFilter = action.input.developerSessionId === undefined
        ? undefined
        : String(action.input.developerSessionId);
      const inMemory = [...this.#sessions.values()]
        .filter((session) => !developerSessionFilter || session.developerSessionId === developerSessionFilter)
        .map((session) => this.#sessionSummary(session));
      const durable = this.#ownership
        ? (developerSessionFilter
          ? await this.#ownership.listForDeveloperSession(developerSessionFilter)
          : await this.#ownership.listAll())
        : [];
      const known = new Set(this.#sessions.keys());
      const detached = durable
        .filter((record) => !known.has(record.processSessionId))
        .map((record) => this.#ownedRecordSummary(record));
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: { sessions: [...inMemory, ...detached] },
        evidence: [
          evidence(
            'process_session',
            'pass',
            'Managed terminal sessions listed with durable restart ownership when available.',
            { inMemoryCount: inMemory.length, detachedCount: detached.length }
          )
        ],
        durationMs: Math.round(performance.now() - started)
      };
    }

    const sessionId = requiredSessionId(action.input.sessionId);
    const session = this.#sessions.get(sessionId);
    if (!session) {
      if (this.#ownership) {
        try {
          const owned = await this.#ownership.get(sessionId);
          if (operation === 'terminate') {
            const identity = await this.#ownership.claimTermination(sessionId);
            if (identity) {
              await terminateOwnedProcessInstance(identity);
              await this.#ownership.markTerminated(sessionId, identity);
            }
            const finalRecord = await this.#ownership.get(sessionId);
            return {
              ok: true,
              capability: action.capability,
              provider: this.name,
              output: this.#ownedRecordSummary(finalRecord),
              evidence: [
                evidence(
                  'process_session_terminate',
                  'pass',
                  identity
                    ? 'Restart-recovered Developer Session process tree terminated using exact process-instance ownership.'
                    : 'Durable Developer Session process was already no longer running.',
                  { sessionId, developerSessionId: finalRecord.developerSessionId }
                )
              ],
              durationMs: Math.round(performance.now() - started)
            };
          }
          if (owned.phase === 'AMBIGUOUS' || owned.phase === 'LAUNCH_INTENT') {
            return failure(
              action,
              this.name,
              started,
              'DEVELOPER_RUNTIME_OWNERSHIP_AMBIGUOUS',
              'Managed process ownership is ambiguous after a crash window; stream access and automatic termination are refused.'
            );
          }
          if (owned.phase === 'RUNNING' || owned.phase === 'TERMINATION_PENDING') {
            return failure(
              action,
              this.name,
              started,
              'SESSION_DETACHED_AFTER_RESTART',
              'Durably owned process survived provider restart, but its stdin/stdout pipes cannot be reattached. It may be listed or terminated safely.'
            );
          }
          return failure(action, this.name, started, 'SESSION_NOT_RUNNING', 'Durably owned terminal session is no longer running.');
        } catch (error) {
          if ((error as { code?: string }).code !== 'DEVELOPER_RUNTIME_SESSION_NOT_FOUND') {
            const op = error instanceof OperatorError
              ? error
              : new OperatorError('PROCESS_SESSION_RECOVERY_FAILED', error instanceof Error ? error.message : String(error));
            return failure(action, this.name, started, op);
          }
        }
      }
      return failure(action, this.name, started, 'SESSION_NOT_FOUND', 'Managed terminal session was not found.');
    }

    if (operation === 'read') {
      const afterCursor = boundedInteger(action.input.afterCursor, 0, 0, Number.MAX_SAFE_INTEGER);
      const maxEvents = boundedInteger(action.input.maxEvents, 100, 1, 500);
      const maxBytes = boundedInteger(action.input.maxBytes, 64 * 1024, 1024, 128 * 1024);
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
      if (context.signal?.aborted) return failure(action, this.name, started, new OperatorError('EXECUTION_ABORTED', 'Terminal session write was cancelled before dispatch.', { details: { sideEffectState: 'none' } }));
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            context.signal?.removeEventListener('abort', onAbort);
            error ? reject(error) : resolve();
          };
          const onAbort = () => finish(new OperatorError('EXECUTION_ABORTED', 'Terminal session write was cancelled after dispatch.', { details: { sideEffectState: 'uncertain' } }));
          context.signal?.addEventListener('abort', onAbort, { once: true });
          session.child.stdin.write(input, (error) => finish(error));
        });
      } catch (error) {
        const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_SESSION_WRITE_FAILED', error instanceof Error ? error.message : String(error), { details: { sideEffectState: 'uncertain' } });
        return failure(action, this.name, started, op);
      }
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
        try {
          if (session.processInstance && this.#ownership) {
            const identity = await this.#ownership.claimTermination(session.id);
            if (identity) {
              if (!sameProcessInstance(session.processInstance, identity)) {
                throw new OperatorError(
                  'DEVELOPER_RUNTIME_PROCESS_IDENTITY_MISMATCH',
                  'Durable ownership identity changed before termination.'
                );
              }
              await terminateOwnedProcessInstance(identity);
              await this.#ownership.markTerminated(session.id, identity);
            }
          } else {
            await terminateProcessTree(session.child, session.pid, context.signal, session.ownsProcessGroup);
          }
        } catch (error) {
          const op = error instanceof OperatorError
            ? error
            : new OperatorError('PROCESS_TREE_TERMINATION_FAILED', error instanceof Error ? error.message : String(error));
          return {
            ok: false,
            capability: action.capability,
            provider: this.name,
            evidence: [evidence('process_session_terminate', 'fail', op.message, { sessionId, pid: session.pid, code: op.code })],
            error: {
              code: op.code,
              message: op.message,
              retryable: op.retryable,
              sideEffectState: 'uncertain',
              ...(op.details ? { details: structuredClone(op.details) } : {})
            },
            durationMs: Math.round(performance.now() - started)
          };
        }
        session.state = 'terminated';
        session.updatedAt = new Date().toISOString();
        this.#appendSessionEvent(session, 'system', 'termination requested');
      }
      return {
        ok: true,
        capability: action.capability,
        provider: this.name,
        output: this.#sessionSummary(session),
        evidence: [
          evidence(
            'process_session_terminate',
            'pass',
            session.processInstance
              ? 'Durably owned Developer Session process tree termination was verified against exact process identity.'
              : 'Managed terminal session termination requested for its owned process tree.',
            { sessionId, pid: session.pid }
          )
        ],
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
      const rows = await runTasklist(signal, pidFilter);
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
      return failure(action, this.name, started, op);
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
      const processes = await runTasklistVerbose(signal, pid);
      const target = processes.find((entry) => entry.pid === pid);
      if (!target) return failure(action, this.name, started, 'PROCESS_NOT_FOUND', 'Process no longer exists.');
      if (target.fingerprint !== expectedFingerprint) return failure(action, this.name, started, 'PROCESS_PRECONDITION_FAILED', 'Process identity changed since inspection.');
      if (!sameWindowsUser(target.userName, os.userInfo().username)) return failure(action, this.name, started, 'PROCESS_TERMINATE_DENIED', 'Refusing to terminate a process owned by another Windows account.');
      if (CRITICAL_WINDOWS_PROCESSES.has(target.imageName.toLowerCase())) return failure(action, this.name, started, 'PROCESS_TERMINATE_DENIED', 'Refusing to terminate a critical Windows process.');
      await runTaskkill(pid, signal);
      const remaining = (await runTasklist(signal, pid)).some((entry) => entry.pid === pid && entry.fingerprint === expectedFingerprint);
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
      return failure(action, this.name, started, op);
    }
  }

  async #ensureOwnershipRecovered(): Promise<void> {
    if (!this.#ownership) return;
    this.#ownershipRecovered ??= this.#ownership.recover().then(() => undefined);
    await this.#ownershipRecovered;
  }

  #ownedRecordSummary(record: DeveloperRuntimeOwnershipRecord): Record<string, unknown> {
    return {
      sessionId: record.processSessionId,
      developerSessionId: record.developerSessionId,
      pid: record.processInstance?.pid ?? null,
      state: record.phase === 'RUNNING' || record.phase === 'TERMINATION_PENDING'
        ? 'detached-running'
        : record.phase.toLowerCase(),
      durableOwned: true,
      detachedAfterRestart: true,
      ports: [...record.ports],
      startedAt: record.createdAt,
      updatedAt: record.updatedAt
    };
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
      droppedBeforeCursor: session.droppedBeforeCursor,
      durableOwned: Boolean(session.developerSessionId),
      ...(session.developerSessionId ? { developerSessionId: session.developerSessionId } : {}),
      ...(session.ports.length > 0 ? { ports: [...session.ports] } : {})
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
    await this.#ensureOwnershipRecovered();
    await Promise.allSettled([...this.#sessions.values()]
      .filter((session) => session.state === 'running')
      .map(async (session) => {
        if (session.processInstance && this.#ownership) {
          const identity = await this.#ownership.claimTermination(session.id);
          if (identity) {
            await terminateOwnedProcessInstance(identity);
            await this.#ownership.markTerminated(session.id, identity);
          }
        } else {
          await terminateProcessTree(session.child, session.pid, undefined, session.ownsProcessGroup);
        }
        session.state = 'terminated';
      }));

    if (this.#ownership) {
      const inMemory = new Set(this.#sessions.keys());
      const recovered = await this.#ownership.listAll();
      await Promise.allSettled(recovered
        .filter((record) =>
          !inMemory.has(record.processSessionId) &&
          (record.phase === 'RUNNING' || record.phase === 'TERMINATION_PENDING')
        )
        .map(async (record) => {
          const identity = await this.#ownership!.claimTermination(record.processSessionId);
          if (!identity) return;
          await terminateOwnedProcessInstance(identity);
          await this.#ownership!.markTerminated(record.processSessionId, identity);
        }));
    }
    this.#sessions.clear();
  }
}

function processReconciliation(
  status: ProviderReconciliationResult['status'],
  message: string
): ProviderReconciliationResult {
  return {
    status,
    evidence: [evidence('process_reconciliation', status === 'completed' ? 'pass' : 'info', message)]
  };
}

function processReconciled(
  action: ActionRequest,
  provider: string,
  message: string,
  output: Record<string, unknown>
): ProviderReconciliationResult {
  const reconciledEvidence = [
    evidence('process_reconciliation', 'pass', message, output),
    evidence('postcondition', 'pass', 'Process reconciliation used current identity state.', output)
  ];
  const result: ActionResult = {
    ok: true,
    capability: action.capability,
    provider,
    output: { ...output, reconciled: true },
    evidence: reconciledEvidence,
    durationMs: 0
  };
  return { status: 'completed', result, evidence: reconciledEvidence };
}

function failure(action: ActionRequest, provider: string, started: number, codeOrError: string | OperatorError, message?: string): ActionResult {
  const op = codeOrError instanceof OperatorError ? codeOrError : new OperatorError(codeOrError, message ?? codeOrError);
  const sideEffectState = op.details && ['none', 'known', 'uncertain'].includes(String(op.details.sideEffectState))
    ? op.details.sideEffectState as 'none' | 'known' | 'uncertain'
    : undefined;
  return {
    ok: false,
    capability: action.capability,
    provider,
    evidence: [evidence('process_policy', 'fail', op.message, { code: op.code })],
    error: { code: op.code, message: op.message, retryable: op.retryable, ...(sideEffectState ? { sideEffectState } : {}), ...(op.details ? { details: structuredClone(op.details) } : {}) },
    durationMs: Math.round(performance.now() - started)
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeDeclaredPorts(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new OperatorError('DEVELOPER_RUNTIME_PORT_INVALID', 'ports must be an array with at most 128 entries.');
  }
  const ports = value.map((item) => {
    const port = Number(item);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new OperatorError('DEVELOPER_RUNTIME_PORT_INVALID', 'Declared ports must be integers from 1 to 65535.');
    }
    return port;
  });
  return [...new Set(ports)].sort((a, b) => a - b);
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
    let terminationPromise: Promise<void> | undefined;

    const clearTimers = () => {
      clearTimeout(timer);
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
      terminationPromise ??= terminateProcessTree(child, child.pid ?? 0).catch((error) => {
        throw error instanceof OperatorError
          ? error
          : new OperatorError('PROCESS_TREE_TERMINATION_FAILED', error instanceof Error ? error.message : String(error), { retryable: false, details: { sideEffectState: 'uncertain' } });
      });
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

    child.once('close', async (exitCode, closeSignal) => {
      if (settled) return;
      if (terminationPromise) {
        try { await terminationPromise; }
        catch (error) { rejectOnce(error); return; }
      }
      settled = true;
      clearTimers();
      if (aborted) {
        reject(new OperatorError('EXECUTION_ABORTED', 'Process execution was cancelled after its owned process tree quiesced.', { retryable: false, details: { sideEffectState: 'uncertain' } }));
        return;
      }
      if (timedOut) {
        reject(new OperatorError('PROCESS_TIMEOUT', `Process exceeded ${timeoutMs}ms timeout and its owned process tree was terminated.`, { retryable: false, details: { sideEffectState: 'uncertain' } }));
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

async function waitForProcessInstance(
  pid: number,
  signal?: AbortSignal,
  waitMs = 2_000
): Promise<ProcessInstanceIdentity | null> {
  const deadline = performance.now() + waitMs;
  while (performance.now() < deadline) {
    if (signal?.aborted) {
      throw new OperatorError('EXECUTION_ABORTED', 'Process identity establishment was cancelled.');
    }
    const identity = await inspectProcessInstance(pid);
    if (identity) return identity;
    if (!processAlive(pid)) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return await inspectProcessInstance(pid);
}

async function terminateOwnedProcessInstance(
  identity: ProcessInstanceIdentity
): Promise<void> {
  const liveBefore = await inspectProcessInstance(identity.pid);
  if (!sameProcessInstance(identity, liveBefore)) return;

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(identity.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: safeChildEnvironment(process.env)
      });
      killer.once('error', reject);
      killer.once('close', resolve);
    });
    const liveAfter = await inspectProcessInstance(identity.pid);
    if (exitCode !== 0 && sameProcessInstance(identity, liveAfter)) {
      throw new OperatorError(
        'PROCESS_TREE_TERMINATION_FAILED',
        'taskkill failed while the exact owned process instance remained alive.',
        { details: { sideEffectState: 'uncertain' } }
      );
    }
    await waitForProcessInstanceExit(identity);
    return;
  }

  const sendGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };

  sendGroup('SIGTERM');
  try {
    await waitForProcessGroupExit(identity.pid, 1_000);
  } catch {
    const live = await inspectProcessInstance(identity.pid);
    if (sameProcessInstance(identity, live)) sendGroup('SIGKILL');
    await waitForProcessGroupExit(identity.pid, 5_000);
  }
  await waitForProcessInstanceExit(identity);
}

async function waitForProcessInstanceExit(
  identity: ProcessInstanceIdentity,
  waitMs = 5_000
): Promise<void> {
  const deadline = performance.now() + waitMs;
  while (sameProcessInstance(identity, await inspectProcessInstance(identity.pid))) {
    if (performance.now() >= deadline) {
      throw new OperatorError(
        'PROCESS_TERMINATE_POSTCONDITION_FAILED',
        'Exact owned process instance remained alive after termination.',
        { details: { sideEffectState: 'uncertain' } }
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForProcessGroupExit(pid: number, waitMs: number): Promise<void> {
  const deadline = performance.now() + waitMs;
  while (processGroupAlive(pid)) {
    if (performance.now() >= deadline) {
      throw new OperatorError(
        'PROCESS_TERMINATE_POSTCONDITION_FAILED',
        'Owned process group remained alive after termination.',
        { details: { sideEffectState: 'uncertain' } }
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function processGroupAlive(pid: number): boolean {
  if (process.platform === 'win32') return processAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function terminateProcessTree(child: ChildProcess, pid: number, signal?: AbortSignal, ownsProcessGroup = false): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', 'Owned process PID is invalid.', { details: { sideEffectState: 'uncertain' } });
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: safeChildEnvironment(process.env) });
      killer.once('error', reject);
      killer.once('close', resolve);
    });
    if (exitCode !== 0 && processAlive(pid)) throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', `taskkill exited with ${String(exitCode)} while the owned process remained alive.`, { details: { sideEffectState: 'uncertain' } });
    await waitForPidExit(pid, signal);
    return;
  }
  const send = (terminationSignal: NodeJS.Signals) => {
    try {
      if (ownsProcessGroup) process.kill(-pid, terminationSignal);
      else child.kill(terminationSignal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  send('SIGTERM');
  try {
    if (ownsProcessGroup) await waitForProcessGroupExit(pid, 1_000);
    else await waitForPidExit(pid, signal, 1_000);
  } catch {
    send('SIGKILL');
    if (ownsProcessGroup) await waitForProcessGroupExit(pid, 5_000);
    else await waitForPidExit(pid, signal);
  }
}

async function waitForPidExit(pid: number, _signal?: AbortSignal, waitMs = 5_000): Promise<void> {
  const deadline = performance.now() + waitMs;
  while (processAlive(pid)) {
    if (performance.now() >= deadline) throw new OperatorError('PROCESS_TERMINATE_POSTCONDITION_FAILED', 'Owned process remained alive after tree termination.', { retryable: false, details: { sideEffectState: 'uncertain' } });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function processFailureSideEffectState(error: OperatorError): 'none' | 'known' | 'uncertain' {
  const state = error.details?.sideEffectState;
  return state === 'none' || state === 'known' || state === 'uncertain' ? state : 'uncertain';
}

const CRITICAL_WINDOWS_PROCESSES = new Set([
  'system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe',
  'lsass.exe', 'winlogon.exe', 'fontdrvhost.exe'
]);

type WindowsProcessRow = {
  imageName: string; pid: number; sessionName: string; sessionNumber: number; memoryKb: number;
  creationTime?: string;
  fingerprint: string;
};

type WindowsVerboseProcessRow = WindowsProcessRow & {
  status: string; userName: string; cpuTime: string; windowTitle: string;
};

export function processInstanceFingerprint(imageName: string, pid: number, sessionName: string, sessionNumber: number, creationTime = ''): string {
  return crypto.createHash('sha256')
    .update(imageName.toLowerCase()).update('\0')
    .update(String(pid)).update('\0')
    .update(sessionName.toLowerCase()).update('\0')
    .update(String(Number.isFinite(sessionNumber) ? sessionNumber : 0)).update('\0')
    .update(creationTime)
    .digest('hex');
}

async function runTasklist(signal?: AbortSignal, pidFilter?: number): Promise<WindowsProcessRow[]> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
  const args = ['/FO', 'CSV', '/NH'];
  if (pidFilter !== undefined) args.push('/FI', `PID eq ${pidFilter}`);
  const output = await runProcess(executable, args, process.cwd(), 15_000, 8 * 1024 * 1024, {}, signal);
  if (output.exitCode !== 0) throw new OperatorError('PROCESS_INSPECT_FAILED', `tasklist exited with ${String(output.exitCode)}.`);
  const rows: WindowsProcessRow[] = [];
  const creationTime = pidFilter === undefined ? undefined : await queryProcessCreationTime(pidFilter, signal);
  for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
    const cols = parseCsvLine(line);
    if (cols.length < 5) continue;
    const pid = Number(cols[1]);
    const sessionNumber = Number(cols[3]);
    const memoryKb = Number(String(cols[4]).replace(/[^0-9]/g, ''));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const imageName = cols[0]!;
    const sessionName = cols[2] ?? '';
    const normalizedSessionNumber = Number.isFinite(sessionNumber) ? sessionNumber : 0;
    rows.push({
      imageName, pid, sessionName,
      sessionNumber: normalizedSessionNumber,
      memoryKb: Number.isFinite(memoryKb) ? memoryKb : 0,
      ...(creationTime ? { creationTime } : {}),
      fingerprint: processInstanceFingerprint(imageName, pid, sessionName, normalizedSessionNumber, creationTime)
    });
  }
  return rows;
}

async function runTasklistVerbose(signal?: AbortSignal, pidFilter?: number): Promise<WindowsVerboseProcessRow[]> {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
  const args = ['/V', '/FO', 'CSV', '/NH'];
  if (pidFilter !== undefined) args.push('/FI', `PID eq ${pidFilter}`);
  const output = await runProcess(executable, args, process.cwd(), 15_000, 512 * 1024, {}, signal);
  if (output.exitCode !== 0) throw new OperatorError('PROCESS_INSPECT_FAILED', `tasklist exited with ${String(output.exitCode)}.`);
  const rows: WindowsVerboseProcessRow[] = [];
  const creationTime = pidFilter === undefined ? undefined : await queryProcessCreationTime(pidFilter, signal);
  for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
    const cols = parseCsvLine(line);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const sessionNumber = Number(cols[3]);
    const memoryKb = Number(String(cols[4]).replace(/[^0-9]/g, ''));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const imageName = cols[0]!;
    const sessionName = cols[2] ?? '';
    const normalizedSessionNumber = Number.isFinite(sessionNumber) ? sessionNumber : 0;
    rows.push({
      imageName, pid, sessionName,
      sessionNumber: normalizedSessionNumber,
      memoryKb: Number.isFinite(memoryKb) ? memoryKb : 0,
      status: cols[5] ?? '',
      userName: cols[6] ?? '',
      cpuTime: cols[7] ?? '',
      windowTitle: cols.slice(8).join(','),
      ...(creationTime ? { creationTime } : {}),
      fingerprint: processInstanceFingerprint(imageName, pid, sessionName, normalizedSessionNumber, creationTime)
    });
  }
  return rows;
}

async function queryProcessCreationTime(pid: number, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) throw new OperatorError('EXECUTION_ABORTED', 'Process inspection was cancelled.', { retryable: false });
  const identity = await inspectProcessInstance(pid);
  if (identity) return identity.started;
  if (!processAlive(pid)) return undefined;
  throw new OperatorError('PROCESS_INSTANCE_IDENTITY_UNAVAILABLE', 'Could not read the process creation timestamp.');
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
