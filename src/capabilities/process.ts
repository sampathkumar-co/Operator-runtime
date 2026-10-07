import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ActionRequest, ActionResult, ActionRisk, CapabilityExecutionContext, CapabilityProvider, CapabilityScore, ProviderReconciliationRequest, ProviderReconciliationResult } from '../core/types.ts';
import { evidence } from '../core/evidence.ts';
import { OperatorError } from '../core/errors.ts';
import { resolveTrustedExecutable } from '../core/trusted-executable.ts';
import { inspectProcessInstance, observeProcessInstance, sameProcessInstance, type ProcessInstanceIdentity, type ProcessInstanceObserver } from '../core/process-instance.ts';
import { TerminalSessionStore, terminalSessionIsActive, type DurableTerminalSession } from '../core/terminal-session-store.ts';
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
  processInstance: ProcessInstanceIdentity;
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
  ports: number[];
};

export class ProcessProvider implements CapabilityProvider {
  readonly name = 'process.argv';
  #scope: PathScope;
  #allowedExecutables: Set<string>;
  #maxOutputBytes: number;
  #requiredRisk?: ActionRisk;
  #environmentOverrides: Readonly<Record<string, string>>;
  #sessions = new Map<string, ManagedSession>();
  #store?: TerminalSessionStore;
  #observeProcess: ProcessInstanceObserver;
  #beforeOwnershipCommit?: (details: { sessionId: string; pid: number }) => void | Promise<void>;
  #initialized = false;
  #closed = false;
  #sessionSerial: Promise<void> = Promise.resolve();
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
    processObserver?: ProcessInstanceObserver;
    beforeOwnershipCommit?: (details: { sessionId: string; pid: number }) => void | Promise<void>;
  }) {
    this.#scope = new PathScope(options.allowedRoots);
    this.#allowedExecutables = new Set(options.allowedExecutables.map((item) => item.trim().toLowerCase()).filter(Boolean));
    this.#maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES);
    this.#requiredRisk = options.requiredRisk;
    this.#environmentOverrides = validateEnvironmentOverrides(options.environmentOverrides);
    this.#store = options.stateDir ? new TerminalSessionStore(options.stateDir) : undefined;
    this.#observeProcess = options.processObserver ?? observeProcessInstance;
    this.#beforeOwnershipCommit = options.beforeOwnershipCommit;
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

  async initialize(): Promise<void> {
    await this.#withSessionLock(async () => {
      await this.#ensureOwnershipRecovered();
      await this.#ensureInitialized();
    });
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return;
    await this.#ensureOwnershipRecovered();
    if (!this.#store) {
      this.#initialized = true;
      return;
    }
    const records = await this.#store.list();
    for (const record of records.filter(terminalSessionIsActive)) await this.#recoverRecord(record);
    this.#initialized = true;
  }

  async #recoverRecord(record: DurableTerminalSession): Promise<void> {
    if (!this.#store) return;
    if (!record.processInstance || record.pid === undefined) {
      if (record.state !== 'recovery_required') {
        await this.#store.transition(record.sessionId, 'recovery_required', { reason: 'Launch ownership was not fully registered before restart.' });
      }
      return;
    }
    const observation = await this.#observeProcess(record.pid);
    if (observation.status === 'dead') {
      await this.#store.transition(record.sessionId, 'exited', { reason: 'Original process was absent during startup recovery.' });
      return;
    }
    if (observation.status === 'live' && observation.identity && !sameProcessInstance(record.processInstance, observation.identity)) {
      await this.#store.transition(record.sessionId, 'stale_pid', { reason: 'PID now identifies a different process instance; replacement was not touched.' });
      return;
    }
    if (observation.status !== 'live' || !observation.identity) {
      if (record.state !== 'recovery_required') {
        await this.#store.transition(record.sessionId, 'recovery_required', { reason: 'Exact process identity could not be determined; no termination was attempted.' });
      }
      return;
    }

    // Explicit Developer Session ownership is the only restart-survival exception.
    // It must bind the same immutable process instance; PID alone never grants authority.
    if (this.#ownership) {
      try {
        const owned = await this.#ownership.get(record.sessionId);
        if (!owned.processInstance || !sameProcessInstance(record.processInstance, owned.processInstance)) {
          if (record.state !== 'recovery_required') {
            await this.#store.transition(record.sessionId, 'recovery_required', { reason: 'Developer ownership disagrees with terminal process identity; no termination was attempted.' });
          }
          return;
        }
        if (owned.phase === 'RUNNING' || owned.phase === 'TERMINATION_PENDING') return;
        if (owned.phase === 'AMBIGUOUS' || owned.phase === 'LAUNCH_INTENT') {
          if (record.state !== 'recovery_required') {
            await this.#store.transition(record.sessionId, 'recovery_required', { reason: 'Developer ownership is ambiguous after restart; no termination was attempted.' });
          }
          return;
        }
        if (owned.phase === 'EXITED' || owned.phase === 'TERMINATED') {
          await this.#store.transition(record.sessionId, 'exited', { reason: 'Developer ownership proves the original process is no longer active.' });
          return;
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'DEVELOPER_RUNTIME_SESSION_NOT_FOUND') throw error;
      }
    }

    const outcome = await this.#terminateExact(record.processInstance);
    if (outcome === 'terminated' || outcome === 'absent') {
      await this.#store.transition(record.sessionId, 'recovered', { reason: 'Exact owned orphan was quiesced during startup recovery.' });
      return;
    }
    if (outcome === 'stale') {
      await this.#store.transition(record.sessionId, 'stale_pid', { reason: 'PID identity changed before orphan termination; replacement was not touched.' });
      return;
    }
    await this.#store.transition(record.sessionId, 'recovery_required', { reason: 'Exact process identity could not be revalidated; no termination was attempted.' });
  }

  async #withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
    let output!: T;
    const run = this.#sessionSerial.then(async () => { output = await operation(); });
    this.#sessionSerial = run.then(() => undefined, () => undefined);
    await run;
    return output;
  }

  async #ensureOwnershipRecovered(): Promise<void> {
    if (!this.#ownership) return;
    this.#ownershipRecovered ??= this.#ownership.recover().then(() => undefined);
    await this.#ownershipRecovered;
  }

  async execute(action: ActionRequest, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    const started = performance.now();
    if (action.capability === 'terminal.session') return await this.#withSessionLock(async () => {
      await this.#ensureInitialized();
      return await this.#session(action, started, context);
    });
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
      const session = this.#sessions.get(sessionId);
      if (session?.state === 'running') {
        return processReconciliation('not_applied', 'Managed session is still running.');
      }
      if (session) return processReconciled(action, this.name, 'Managed session is no longer running.', this.#sessionSummary(session));
      try {
        await this.#ensureInitialized();
        const durable = await this.#store?.get(sessionId);
        if (!durable) return processReconciliation('uncertain', 'No durable ownership record exists for this managed session.');
        if (durable.state === 'running' || durable.state === 'launching') return processReconciliation('not_applied', 'The exact managed process is still recorded active.');
        if (durable.state === 'recovery_required') return processReconciliation('uncertain', 'Managed-session ownership requires explicit recovery because exact process identity is unavailable.');
        return processReconciled(action, this.name, 'Durable ownership proves the original managed process is no longer active.', this.#durableSummary(durable));
      } catch (error) {
        return processReconciliation('uncertain', error instanceof Error ? error.message : 'Durable terminal-session reconciliation failed closed.');
      }
    }

    return processReconciliation('uncertain', 'Process provider cannot prove the outcome of this mutation from current state.');
  }

  async #session(action: ActionRequest, started: number, context: CapabilityExecutionContext = {}): Promise<ActionResult> {
    this.#pruneSessions();
    if (context.signal?.aborted) return failure(action, this.name, started, 'EXECUTION_ABORTED', 'Terminal session operation was cancelled before dispatch.');
    const operation = String(action.input.operation ?? '');
    if (operation === 'start') {
      if (this.#closed) return failure(action, this.name, started, 'TERMINAL_SESSION_PROVIDER_CLOSED', 'Terminal session provider is shutting down.');
      if (this.#sessions.size >= MAX_SESSIONS) return failure(action, this.name, started, 'SESSION_LIMIT_REACHED', `At most ${MAX_SESSIONS} managed terminal sessions may exist.`);
      const executable = String(action.input.executable ?? '').trim();
      const args = Array.isArray(action.input.args) ? action.input.args.map(String) : [];
      const validation = this.#validateInvocation(executable, args);
      if (validation) return failure(action, this.name, started, validation.code, validation.message);

      const developerSessionId = action.input.developerSessionId === undefined
        ? undefined
        : String(action.input.developerSessionId);
      const ports = normalizeDeclaredPorts(action.input.ports);
      if (ports.length > 0 && !developerSessionId) {
        return failure(action, this.name, started, 'DEVELOPER_RUNTIME_SESSION_REQUIRED', 'Declared ports require developerSessionId so ownership can survive restart.');
      }
      if (developerSessionId && (!this.#ownership || !this.#developerSessions)) {
        return failure(action, this.name, started, 'DEVELOPER_RUNTIME_STATE_REQUIRED', 'Developer Session-bound terminal processes require durable stateDir.');
      }

      const sessionId = crypto.randomUUID();
      let child: ChildProcessWithoutNullStreams | undefined;
      let identity: ProcessInstanceIdentity | undefined;
      let prepared = false;
      let developerLaunchIntent = false;
      let developerOwnershipCommitted = false;
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
        }

        if (this.#store) {
          await this.#store.prepare({ sessionId, executable });
          prepared = true;
        }
        if (developerSessionId) {
          await this.#ownership!.beginLaunch({ processSessionId: sessionId, developerSessionId, ports });
          developerLaunchIntent = true;
        }

        const cwd = await this.#scope.resolveExisting(String(action.input.cwd ?? ''));
        const env = safeChildEnvironment(process.env, this.#environmentOverrides);
        const trustedExecutable = resolveTrustedExecutable(executable, env);
        child = spawn(trustedExecutable, args, {
          cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env
        }) as ChildProcessWithoutNullStreams;
        if (!child.pid) throw new OperatorError('PROCESS_START_FAILED', 'Process did not return a PID.');

        identity = await waitForProcessIdentity(child.pid, this.#observeProcess);
        if (!identity) throw new OperatorError('TERMINAL_SESSION_IDENTITY_UNAVAILABLE', 'Spawned process identity could not be established; start was rolled back.', { details: { sideEffectState: 'uncertain' } });
        if (this.#store) await this.#store.bindProcess(sessionId, identity);
        await this.#beforeOwnershipCommit?.({ sessionId, pid: child.pid });
        if (this.#store) await this.#store.activate(sessionId, identity);
        if (developerSessionId) {
          await this.#ownership!.commitLaunch(sessionId, identity);
          developerOwnershipCommitted = true;
        }

        const session: ManagedSession = {
          id: sessionId, executable, args: [...args], cwd, child, pid: child.pid, processInstance: identity,
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          state: 'running', exitCode: null, signal: null, events: [], nextCursor: 1,
          droppedBeforeCursor: 0, bufferedBytes: 0,
          ...(developerSessionId ? { developerSessionId } : {}),
          ports
        };
        this.#sessions.set(session.id, session);
        this.#appendSessionEvent(session, 'system', `process started pid=${session.pid}`);
        child.stdout.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stdout', chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => this.#appendSessionEvent(session, 'stderr', chunk.toString('utf8')));
        child.once('error', (error) => {
          session.state = 'failed';
          session.updatedAt = new Date().toISOString();
          this.#appendSessionEvent(session, 'system', `process error: ${error.message}`);
          void this.#store?.transition(session.id, 'failed', { reason: 'Owned child emitted a process error.' }).catch(() => undefined);
        });
        child.once('close', (code, signal) => {
          session.exitCode = code;
          session.signal = signal;
          session.updatedAt = new Date().toISOString();
          if (session.state === 'running') {
            session.state = 'exited';
            void this.#store?.transition(session.id, 'exited', { reason: 'Owned child exited.' }).catch(() => undefined);
            if (session.developerSessionId && this.#ownership) {
              void this.#ownership.markExited(session.id, session.processInstance, session.updatedAt).catch(() => undefined);
            }
          }
          this.#appendSessionEvent(session, 'system', `process exited code=${String(code)} signal=${String(signal ?? '')}`);
        });

        if (context.signal?.aborted) {
          const outcome = await this.#terminateExact(identity, child);
          session.state = outcome === 'stale' ? 'exited' : 'terminated';
          await this.#store?.transition(session.id, outcome === 'stale' ? 'stale_pid' : 'terminated', {
            reason: 'Start was aborted after ownership commit and the exact child was quiesced.'
          });
          if (developerSessionId && developerOwnershipCommitted && this.#ownership) {
            if (outcome === 'stale') await this.#ownership.markExited(session.id, identity).catch(() => undefined);
            else await this.#ownership.markTerminated(session.id, identity).catch(() => undefined);
          }
          return failure(action, this.name, started, new OperatorError('EXECUTION_ABORTED', 'Terminal session start was cancelled after process creation; the owned process tree was quiesced.', { details: { sideEffectState: 'uncertain' } }));
        }

        return {
          ok: true, capability: action.capability, provider: this.name,
          output: this.#sessionSummary(session),
          evidence: [evidence(
            'process_session',
            'pass',
            developerSessionId
              ? 'Managed terminal session started with both terminal ownership and Developer Session ownership committed.'
              : 'Managed shell-free terminal session started.',
            { sessionId: session.id, pid: session.pid, executable, cwd, durableOwned: Boolean(developerSessionId), portCount: ports.length }
          )],
          durationMs: Math.round(performance.now() - started)
        };
      } catch (error) {
        let quiesced = false;
        if (child?.pid) {
          try {
            if (identity) {
              const outcome = await this.#terminateExact(identity, child);
              quiesced = outcome === 'terminated' || outcome === 'absent' || outcome === 'stale';
            } else {
              await terminateProcessTree(child, child.pid);
              quiesced = true;
            }
          } catch {}
        }

        if (developerSessionId && this.#ownership && developerLaunchIntent) {
          try {
            if (developerOwnershipCommitted && identity && quiesced) {
              await this.#ownership.markTerminated(sessionId, identity);
            } else if (!developerOwnershipCommitted) {
              await this.#ownership.abortLaunch(sessionId);
            }
          } catch {}
        }

        if (prepared && this.#store) {
          try {
            await this.#store.transition(sessionId, quiesced || !child ? 'failed' : 'recovery_required', {
              ...(identity ? { identity } : {}),
              reason: quiesced
                ? 'Session start failed and spawned process was quiesced.'
                : child
                  ? 'Session start failed after spawn; cleanup requires recovery.'
                  : 'Session start failed before process creation.'
            });
          } catch {}
        }

        const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_START_FAILED', error instanceof Error ? error.message : String(error));
        return failure(action, this.name, started, new OperatorError(
          child ? 'TERMINAL_SESSION_START_COMMIT_FAILED' : op.code,
          op.message,
          { retryable: false, details: { ...(op.details ?? {}), sideEffectState: child ? (quiesced ? 'known' : 'uncertain') : 'none' } }
        ));
      }
    }

    if (operation === 'list') {
      const developerSessionFilter = action.input.developerSessionId === undefined
        ? undefined
        : String(action.input.developerSessionId);
      const durable = await this.#store?.list() ?? [];
      const developerOwnership = this.#ownership
        ? (developerSessionFilter
          ? await this.#ownership.listForDeveloperSession(developerSessionFilter)
          : await this.#ownership.listAll())
        : [];
      const ownershipById = new Map(developerOwnership.map((record) => [record.processSessionId, record]));
      const memoryIds = new Set(this.#sessions.keys());
      const inMemory = [...this.#sessions.values()]
        .filter((session) => !developerSessionFilter || session.developerSessionId === developerSessionFilter)
        .map((session) => this.#sessionSummary(session));
      const detached = durable
        .filter((record) => !memoryIds.has(record.sessionId))
        .filter((record) => {
          if (!developerSessionFilter) return true;
          return ownershipById.get(record.sessionId)?.developerSessionId === developerSessionFilter;
        })
        .map((record) => {
          const owned = ownershipById.get(record.sessionId);
          return owned ? this.#ownedRecordSummary(owned) : this.#durableSummary(record);
        });
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { sessions: [...inMemory, ...detached] },
        evidence: [evidence('process_session', 'pass', 'Managed terminal sessions listed with exact durable restart ownership.', {
          inMemoryCount: inMemory.length,
          detachedCount: detached.length
        })],
        durationMs: Math.round(performance.now() - started)
      };
    }

    const sessionId = requiredSessionId(action.input.sessionId);
    const session = this.#sessions.get(sessionId);
    const durable = session ? undefined : await this.#store?.get(sessionId);
    let developerOwned: DeveloperRuntimeOwnershipRecord | undefined;
    if (!session && this.#ownership) {
      try { developerOwned = await this.#ownership.get(sessionId); }
      catch (error) {
        if ((error as { code?: string }).code !== 'DEVELOPER_RUNTIME_SESSION_NOT_FOUND') {
          const op = error instanceof OperatorError
            ? error
            : new OperatorError('PROCESS_SESSION_RECOVERY_FAILED', error instanceof Error ? error.message : String(error));
          return failure(action, this.name, started, op);
        }
      }
    }
    if (!session && !durable && !developerOwned) return failure(action, this.name, started, 'SESSION_NOT_FOUND', 'Managed terminal session was not found.');

    if (operation === 'read') {
      if (!session) {
        if (developerOwned?.phase === 'RUNNING' || developerOwned?.phase === 'TERMINATION_PENDING') {
          return failure(action, this.name, started, 'SESSION_DETACHED_AFTER_RESTART', 'Durably owned Developer Session process survived provider restart, but stdin/stdout pipes cannot be reattached.');
        }
        if (developerOwned?.phase === 'AMBIGUOUS' || developerOwned?.phase === 'LAUNCH_INTENT') {
          return failure(action, this.name, started, 'DEVELOPER_RUNTIME_OWNERSHIP_AMBIGUOUS', 'Developer Session process ownership is ambiguous after restart; stream access is refused.');
        }
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: {
            ...(developerOwned ? this.#ownedRecordSummary(developerOwned) : this.#durableSummary(durable!)),
            events: [], cursor: 0, droppedBeforeCursor: 0, truncatedBefore: false
          },
          evidence: [evidence('process_session_read', 'pass', 'Durable terminal-session tombstone read; stdio is not persisted or reattached.', { sessionId })],
          durationMs: Math.round(performance.now() - started)
        };
      }
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
      if (!session) return failure(action, this.name, started, 'SESSION_NOT_RUNNING', 'Recovered terminal session has no reattachable stdin.');
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
      if (!session) {
        if (developerOwned) {
          if (developerOwned.phase === 'AMBIGUOUS' || developerOwned.phase === 'LAUNCH_INTENT') {
            return failure(action, this.name, started, 'DEVELOPER_RUNTIME_OWNERSHIP_AMBIGUOUS', 'Developer Session process ownership is ambiguous; exact termination authority cannot be established.');
          }
          if (developerOwned.phase === 'RUNNING' || developerOwned.phase === 'TERMINATION_PENDING') {
            try {
              const identity = await this.#ownership!.claimTermination(sessionId);
              if (identity) {
                const outcome = await this.#terminateExact(identity, undefined, context.signal);
                if (outcome === 'unknown') {
                  throw new OperatorError('TERMINAL_SESSION_RECOVERY_BLOCKED', 'Exact Developer Session process identity could not be revalidated.');
                }
                if (outcome === 'stale') await this.#ownership!.markExited(sessionId, identity);
                else await this.#ownership!.markTerminated(sessionId, identity);
                const terminal = await this.#store?.get(sessionId);
                if (terminal && terminalSessionIsActive(terminal)) {
                  await this.#store?.transition(sessionId, outcome === 'stale' ? 'stale_pid' : 'terminated', {
                    reason: outcome === 'stale'
                      ? 'PID identified a replacement process; replacement was not touched.'
                      : 'Detached Developer Session process was terminated from exact durable ownership.'
                  });
                }
              }
              developerOwned = await this.#ownership!.get(sessionId);
            } catch (error) {
              const op = error instanceof OperatorError
                ? error
                : new OperatorError('PROCESS_TREE_TERMINATION_FAILED', error instanceof Error ? error.message : String(error));
              return failure(action, this.name, started, op);
            }
          }
          return {
            ok: true, capability: action.capability, provider: this.name,
            output: this.#ownedRecordSummary(developerOwned),
            evidence: [evidence('process_session_terminate', 'pass', 'Detached Developer Session process termination reconciled from exact process-instance ownership.', {
              sessionId,
              developerSessionId: developerOwned.developerSessionId
            })],
            durationMs: Math.round(performance.now() - started)
          };
        }

        if (durable!.state === 'recovery_required' || durable!.state === 'running' || durable!.state === 'launching') {
          return failure(action, this.name, started, 'TERMINAL_SESSION_RECOVERY_BLOCKED', 'Exact terminal-session process ownership is unresolved; no PID-only termination was attempted.');
        }
        return {
          ok: true, capability: action.capability, provider: this.name,
          output: this.#durableSummary(durable!),
          evidence: [evidence('process_session_terminate', 'pass', 'Durable ownership proves the original process is already inactive.', { sessionId })],
          durationMs: Math.round(performance.now() - started)
        };
      }

      if (session.state === 'running') {
        let outcome: 'terminated' | 'absent' | 'stale' | 'unknown';
        try {
          outcome = await this.#terminateExact(session.processInstance, session.child, context.signal);
          if (outcome === 'unknown') throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', 'Exact owned process identity could not be revalidated.', { details: { sideEffectState: 'uncertain' } });
          if (session.developerSessionId && this.#ownership) {
            if (outcome === 'stale') await this.#ownership.markExited(session.id, session.processInstance);
            else await this.#ownership.markTerminated(session.id, session.processInstance);
          }
        } catch (error) {
          const op = error instanceof OperatorError ? error : new OperatorError('PROCESS_TREE_TERMINATION_FAILED', error instanceof Error ? error.message : String(error));
          return {
            ok: false, capability: action.capability, provider: this.name,
            evidence: [evidence('process_session_terminate', 'fail', op.message, { sessionId, pid: session.pid, code: op.code })],
            error: { code: op.code, message: op.message, retryable: op.retryable, sideEffectState: 'uncertain', ...(op.details ? { details: structuredClone(op.details) } : {}) },
            durationMs: Math.round(performance.now() - started)
          };
        }
        session.state = outcome === 'stale' ? 'exited' : 'terminated';
        session.updatedAt = new Date().toISOString();
        await this.#store?.transition(session.id, outcome === 'stale' ? 'stale_pid' : 'terminated', {
          reason: outcome === 'stale'
            ? 'PID identified a replacement process; original process is absent and replacement was not touched.'
            : 'Explicit termination completed or original process identity was already absent.'
        });
        this.#appendSessionEvent(session, 'system', 'termination requested');
      }
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: this.#sessionSummary(session),
        evidence: [evidence('process_session_terminate', 'pass', 'Managed terminal session termination requested for its exact owned process tree.', { sessionId, pid: session.pid })],
        durationMs: Math.round(performance.now() - started)
      };
    }
    return failure(action, this.name, started, 'PROCESS_INPUT_INVALID', 'terminal.session operation must be start, list, read, write, or terminate.');
  }

  async #inspectProcesses(action: ActionRequest, started: number, signal?: AbortSignal): Promise<ActionResult> {
    if (process.platform !== 'win32') return failure(action, this.name, started, 'WINDOWS_ONLY', 'System process inspection is currently certified only on Windows.');
    try {
      const limit = boundedInteger(action.input.limit, 200, 1, MAX_PROCESS_INSPECT_RESULTS);
      const offset = boundedInteger(action.input.offset, 0, 0, 1_000_000);
      const nameFilter = typeof action.input.name === 'string' ? action.input.name.trim().toLowerCase() : '';
      const pidFilter = action.input.pid === undefined ? undefined : boundedInteger(action.input.pid, 0, 1, 0x7fff_ffff);
      const rows = await runTasklist(signal, pidFilter);
      const matching = rows
        .filter((row) => (pidFilter === undefined || row.pid === pidFilter) && (!nameFilter || row.imageName.toLowerCase().includes(nameFilter)))
        .sort((left, right) => left.pid - right.pid || left.imageName.localeCompare(right.imageName));
      const processes = matching.slice(offset, offset + limit);
      const nextOffset = offset + processes.length;
      const truncated = nextOffset < matching.length;
      return {
        ok: true, capability: action.capability, provider: this.name,
        output: { processes, offset, limit, total: matching.length, truncated, ...(truncated ? { nextOffset } : {}) },
        evidence: [evidence('process_inspect', 'pass', 'Windows process table page inspected deterministically through tasklist without command lines or environment data.', { count: processes.length, offset, total: matching.length })],
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

  #durableSummary(record: DurableTerminalSession): Record<string, unknown> {
    return {
      sessionId: record.sessionId,
      ...(record.pid === undefined ? {} : { pid: record.pid }),
      executable: record.executable,
      state: record.state,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      durable: true,
      reattachable: false,
      ...(record.terminalReason ? { terminalReason: record.terminalReason } : {})
    };
  }

  async #terminateExact(
    identity: ProcessInstanceIdentity,
    child?: ChildProcess,
    signal?: AbortSignal
  ): Promise<'terminated' | 'absent' | 'stale' | 'unknown'> {
    const first = await this.#observeProcess(identity.pid);
    if (first.status === 'dead') return 'absent';
    if (first.status !== 'live' || !first.identity) return 'unknown';
    if (!sameProcessInstance(identity, first.identity)) return 'stale';
    const immediatelyBefore = await this.#observeProcess(identity.pid);
    if (immediatelyBefore.status === 'dead') return 'absent';
    if (immediatelyBefore.status !== 'live' || !immediatelyBefore.identity) return 'unknown';
    if (!sameProcessInstance(identity, immediatelyBefore.identity)) return 'stale';
    await terminateProcessTree(child, identity.pid, signal, identity, this.#observeProcess);
    const after = await this.#observeProcess(identity.pid);
    if (after.status === 'dead') return 'terminated';
    if (after.status === 'live' && after.identity && !sameProcessInstance(identity, after.identity)) return 'terminated';
    throw new OperatorError('PROCESS_TERMINATE_POSTCONDITION_FAILED', 'Exact owned process instance remained after tree termination.', { details: { sideEffectState: 'uncertain' } });
  }

  #pruneSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      const age = now - Date.parse(session.updatedAt);
      if (session.state !== 'running' && age > MAX_SESSION_IDLE_MS) this.#sessions.delete(id);
    }
  }

  async emergencyStop(): Promise<void> {
    await this.#withSessionLock(async () => {
      await this.#ensureInitialized();
      await this.#quiesceSessions('Emergency stop quiesced the exact owned process.');
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#withSessionLock(async () => {
      await this.#ensureInitialized();
      await this.#quiesceSessions('Graceful provider shutdown quiesced the exact owned process.');
      this.#sessions.clear();
    });
  }

  async #quiesceSessions(reason: string): Promise<void> {
    const failures: unknown[] = [];
    const inMemoryIds = new Set(this.#sessions.keys());

    for (const session of this.#sessions.values()) {
      if (session.state !== 'running') continue;
      try {
        const outcome = await this.#terminateExact(session.processInstance, session.child);
        if (outcome === 'unknown') throw new OperatorError('TERMINAL_SESSION_RECOVERY_BLOCKED', 'Exact owned process identity could not be revalidated.');
        session.state = outcome === 'stale' ? 'exited' : 'terminated';
        session.updatedAt = new Date().toISOString();
        const durable = await this.#store?.get(session.id);
        if (!durable || durable.state === 'running') {
          await this.#store?.transition(session.id, outcome === 'stale' ? 'stale_pid' : 'terminated', { reason });
        }
        if (session.developerSessionId && this.#ownership) {
          if (outcome === 'stale') await this.#ownership.markExited(session.id, session.processInstance);
          else await this.#ownership.markTerminated(session.id, session.processInstance);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (this.#ownership) {
      try {
        const detached = (await this.#ownership.listAll()).filter((record) =>
          !inMemoryIds.has(record.processSessionId)
          && (record.phase === 'RUNNING' || record.phase === 'TERMINATION_PENDING')
        );
        for (const record of detached) {
          try {
            const identity = await this.#ownership.claimTermination(record.processSessionId);
            if (!identity) continue;
            const outcome = await this.#terminateExact(identity);
            if (outcome === 'unknown') throw new OperatorError('TERMINAL_SESSION_RECOVERY_BLOCKED', 'Detached Developer Session process identity could not be revalidated.');
            if (outcome === 'stale') await this.#ownership.markExited(record.processSessionId, identity);
            else await this.#ownership.markTerminated(record.processSessionId, identity);
            const durable = await this.#store?.get(record.processSessionId);
            if (durable && terminalSessionIsActive(durable)) {
              await this.#store?.transition(record.processSessionId, outcome === 'stale' ? 'stale_pid' : 'terminated', { reason });
            }
          } catch (error) {
            failures.push(error);
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) throw failures[0];
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

async function waitForProcessIdentity(pid: number, observer: ProcessInstanceObserver): Promise<ProcessInstanceIdentity | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observation = await observer(pid);
    if (observation.status === 'live' && observation.identity) return observation.identity;
    if (observation.status === 'dead') return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function terminateProcessTree(
  child: ChildProcess | undefined,
  pid: number,
  signal?: AbortSignal,
  expectedIdentity?: ProcessInstanceIdentity,
  observer: ProcessInstanceObserver = observeProcessInstance
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', 'Owned process PID is invalid.', { details: { sideEffectState: 'uncertain' } });
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: safeChildEnvironment(process.env) });
      killer.once('error', reject);
      killer.once('close', resolve);
    });
    if (expectedIdentity) {
      try {
        await waitForExactProcessExit(expectedIdentity, observer, signal);
      } catch (error) {
        if (exitCode !== 0) {
          throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', `taskkill exited with ${String(exitCode)} and exact process termination could not be proven.`, { details: { sideEffectState: 'uncertain', cause: error instanceof Error ? error.message : String(error) } });
        }
        throw error;
      }
      return;
    }
    if (exitCode !== 0 && processAlive(pid)) throw new OperatorError('PROCESS_TREE_TERMINATION_FAILED', `taskkill exited with ${String(exitCode)} while the owned process remained alive.`, { details: { sideEffectState: 'uncertain' } });
    await waitForPidExit(pid, signal);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child?.kill('SIGTERM'); } catch {} }
  try { await waitForPidExit(pid, signal, 1_000); }
  catch {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch {} }
    await waitForPidExit(pid, signal);
  }
}

async function waitForExactProcessExit(
  identity: ProcessInstanceIdentity,
  observer: ProcessInstanceObserver,
  _signal?: AbortSignal,
  waitMs = 5_000
): Promise<void> {
  const deadline = performance.now() + waitMs;
  while (true) {
    const observation = await observer(identity.pid);
    if (observation.status === 'dead') return;
    if (observation.status === 'live' && observation.identity && !sameProcessInstance(identity, observation.identity)) return;
    if (observation.status === 'unknown' && process.platform === 'win32') {
      const absent = await windowsPidDefinitelyAbsent(identity.pid, _signal);
      if (absent === true) return;
    }
    if (performance.now() >= deadline) {
      throw new OperatorError(
        'PROCESS_TERMINATE_POSTCONDITION_FAILED',
        observation.status === 'unknown'
          ? 'Exact process termination could not be proven because process identity remained unavailable.'
          : 'Exact owned process instance remained after tree termination.',
        { retryable: false, details: { sideEffectState: 'uncertain' } }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function windowsPidDefinitelyAbsent(pid: number, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
    const output = await runProcess(
      executable,
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      process.cwd(),
      5_000,
      64 * 1024,
      {},
      signal
    );
    if (output.exitCode !== 0) return undefined;
    for (const line of output.stdout.split(/\r?\n/).filter(Boolean)) {
      const cols = parseCsvLine(line);
      if (cols.length >= 2 && Number(cols[1]) === pid) return false;
    }
    return true;
  } catch {
    return undefined;
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
