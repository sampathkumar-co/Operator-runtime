import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeChildEnvironment } from './child-environment.ts';

const execFileAsync = promisify(execFile);

export interface ProcessInstanceIdentity {
  pid: number;
  /** OS process creation identity. This is intentionally opaque and compared byte-for-byte. */
  started: string;
}

export type ProcessInstanceInspector = (pid: number) => Promise<ProcessInstanceIdentity | null>;
export type ProcessInstanceObservation =
  | { status: 'live'; identity?: ProcessInstanceIdentity }
  | { status: 'dead' }
  | { status: 'unknown' };
export type ProcessInstanceObserver = (pid: number) => Promise<ProcessInstanceObservation>;

export function observerFromLegacyInspector(inspector: ProcessInstanceInspector): ProcessInstanceObserver {
  return async (pid) => {
    try {
      const identity = await inspector(pid);
      return identity ? { status: 'live', identity } : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  };
}

export function processInstanceDefinitelyStale(
  storedIdentity: ProcessInstanceIdentity | undefined,
  observation: ProcessInstanceObservation
): boolean {
  if (observation.status === 'dead') return true;
  if (observation.status !== 'live' || !storedIdentity || !observation.identity) return false;
  // A pre-upgrade Linux PID/tick identity does not include a boot UUID.
  // Its mismatch with a boot-bound v2 observation is *uncertain*, not proof
  // of a different/dead process. Keep its lease fenced until confirmed death
  // or an explicit, independently proven owner transition.
  if (linuxIdentityUpgradeUncertain(storedIdentity.started, observation.identity.started)) return false;
  return !sameProcessInstance(storedIdentity, observation.identity);
}

/**
 * A local PID observer can only reclaim an owner if the stored identity is
 * plausibly from this host. Linux v2 identifies a single boot; Linux v1
 * contains no host provenance and must be reconciled conservatively.
 *
 * Other platform identities predate host provenance. Their existing local
 * process checks are NOT a cross-host proof and still require distributed
 * provider-side fencing before multi-host execution can be certified.
 */
export function localPidObservationAdmissible(
  storedIdentity: ProcessInstanceIdentity | undefined,
  localIdentity: ProcessInstanceIdentity
): boolean {
  if (!storedIdentity) return false;
  const stored = storedIdentity.started;
  const linuxBoot = /^linux-boot-id:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):ticks:\d+$/.exec(stored)?.[1];
  if (linuxBoot) {
    const localBoot = /^linux-boot-id:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):ticks:\d+$/.exec(localIdentity.started)?.[1];
    return localBoot === linuxBoot;
  }
  if (stored.startsWith('linux-boot-')) return false;
  return true;
}

let currentIdentity: Promise<ProcessInstanceIdentity> | undefined;

export async function inspectProcessInstance(pid: number): Promise<ProcessInstanceIdentity | null> {
  if (pid === process.pid && currentIdentity) return await currentIdentity;
  const observation = await observeProcessInstance(pid);
  return observation.status === 'live' && observation.identity ? observation.identity : null;
}

export async function observeProcessInstance(pid: number): Promise<ProcessInstanceObservation> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) return { status: 'dead' };
  if (pid === process.pid && currentIdentity) return { status: 'live', identity: await currentIdentity };
  return await observeProcessInstanceUncached(pid);
}

function observeProcessInstanceUncached(pid: number): Promise<ProcessInstanceObservation> {
  if (process.platform === 'win32') return observeWindowsProcess(pid);
  if (process.platform === 'linux') return observeLinuxProcess(pid);
  return observePortableProcess(pid);
}

export function currentProcessInstance(): Promise<ProcessInstanceIdentity> {
  currentIdentity ??= observeProcessInstanceUncached(process.pid).then((observation) => {
    if (observation.status !== 'live' || !observation.identity) {
      throw new Error('Unable to establish the current process instance identity.');
    }
    return observation.identity;
  });
  return currentIdentity;
}

function linuxIdentityUpgradeUncertain(left: string, right: string): boolean {
  const oldPattern = /^linux-boot-ticks:\d+$/;
  const newPattern = /^linux-boot-id:[0-9a-f-]{36}:ticks:\d+$/;
  return (oldPattern.test(left) && newPattern.test(right)) ||
    (newPattern.test(left) && oldPattern.test(right));
}

export function sameProcessInstance(left: ProcessInstanceIdentity, right: ProcessInstanceIdentity | null): boolean {
  if (right === null || left.pid !== right.pid) return false;
  if (left.started === right.started) return true;
  const leftWindowsMs = windowsStartedMillisecond(left.started);
  const rightWindowsMs = windowsStartedMillisecond(right.started);
  return leftWindowsMs !== null && rightWindowsMs !== null && leftWindowsMs === rightWindowsMs;
}

export function validProcessInstance(input: unknown): ProcessInstanceIdentity | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  // An OS process ID is a typed ownership identity, never caller-coerced metadata.
  const pid = value.pid;
  const started = typeof value.started === 'string' ? value.started : '';
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff || started.length < 1 || started.length > 256 || started.includes('\0')) return null;
  return { pid, started };
}

async function observeWindowsProcess(pid: number): Promise<ProcessInstanceObservation> {
  const nativeHelper = process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  if (nativeHelper && path.isAbsolute(nativeHelper)) {
    try {
      const { stdout } = await execFileAsync(nativeHelper, ['process-instance', String(pid)], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        encoding: 'utf8',
        env: safeChildEnvironment('windows-native')
      });
      const started = stdout.trim();
      if (/^\d{15,20}$/.test(started)) return { status: 'live', identity: { pid, started: `windows-filetime:${started}` } };
    } catch {
      // Fall through to the independent OS probe so helper failure is not
      // conflated with confirmed process death.
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Distinguish confirmed absence from probe failure. A lease may be reclaimed
  // only from confirmed absence or a confirmed different process instance.
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-eq$p){'dead'}else{try{'live:'+$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}catch{'unknown'}}`;
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8'
    });
    const observed = stdout.trim();
    if (observed === 'dead') return { status: 'dead' };
    const live = /^live:(\d{15,20})$/.exec(observed);
    if (live) return { status: 'live', identity: { pid, started: `windows-filetime:${live[1]}` } };
    return { status: 'unknown' };
  } catch {
    return { status: 'unknown' };
  }
}

const WINDOWS_EPOCH_FILETIME_MS = 11_644_473_600_000n;

function windowsStartedMillisecond(value: string): bigint | null {
  const filetime = /^windows-filetime:(\d{15,20})$/.exec(value);
  if (filetime) return BigInt(filetime[1]!) / 10_000n;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  return BigInt(Math.trunc(parsed)) + WINDOWS_EPOCH_FILETIME_MS;
}

async function observeLinuxProcess(pid: number): Promise<ProcessInstanceObservation> {
  // A missing/blocked boot UUID is uncertainty about the *host*, not proof
  // that the target PID is dead. Never pass a boot-id read error into the
  // process-stat ENOENT handler below; it could wrongly reclaim live leases.
  let bootId: string;
  try {
    bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase();
  } catch {
    return { status: 'unknown' };
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) return { status: 'unknown' };
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingName = stat.lastIndexOf(')');
    if (closingName < 0) return { status: 'unknown' };
    const fields = stat.slice(closingName + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // field 22 overall; fields begin at process-state field 3.
    return startTicks
      ? { status: 'live', identity: { pid, started: `linux-boot-id:${bootId}:ticks:${startTicks}` } }
      : { status: 'unknown' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? { status: 'dead' } : { status: 'unknown' };
  }
}

async function observePortableProcess(pid: number): Promise<ProcessInstanceObservation> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { status: 'dead' };
    if (code === 'EPERM' || code === 'EACCES') return { status: 'live' };
    return { status: 'unknown' };
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000, maxBuffer: 16 * 1024, encoding: 'utf8' });
    const started = stdout.trim();
    return started ? { status: 'live', identity: { pid, started: `ps-lstart:${started}` } } : { status: 'live' };
  } catch {
    // kill(pid, 0) already proved the process existed. Failure to read a
    // creation identity is uncertainty about identity, not process death.
    return { status: 'live' };
  }
}
