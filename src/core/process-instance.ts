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

let currentIdentity: Promise<ProcessInstanceIdentity> | undefined;

export function inspectProcessInstance(pid: number): Promise<ProcessInstanceIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) return Promise.resolve(null);
  if (pid === process.pid && currentIdentity) return currentIdentity;
  return inspectProcessInstanceUncached(pid);
}

function inspectProcessInstanceUncached(pid: number): Promise<ProcessInstanceIdentity | null> {
  if (process.platform === 'win32') return inspectWindowsProcess(pid);
  if (process.platform === 'linux') return inspectLinuxProcess(pid);
  return inspectPortableProcess(pid);
}

export function currentProcessInstance(): Promise<ProcessInstanceIdentity> {
  currentIdentity ??= inspectProcessInstanceUncached(process.pid).then((identity) => {
    if (!identity) throw new Error('Unable to establish the current process instance identity.');
    return identity;
  });
  return currentIdentity;
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
  const pid = Number(value.pid);
  const started = typeof value.started === 'string' ? value.started : '';
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff || started.length < 1 || started.length > 256 || started.includes('\0')) return null;
  return { pid, started };
}

async function inspectWindowsProcess(pid: number): Promise<ProcessInstanceIdentity | null> {
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
      return /^\d{15,20}$/.test(started) ? { pid, started: `windows-filetime:${started}` } : null;
    } catch {
      return null;
    }
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Get-Process uses the Win32 process handle path and remains available to
  // packaged full-trust applications where the WMI/CIM provider may not be.
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-ne$p){$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}`;
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8'
    });
    const started = stdout.trim();
    return /^\d{15,20}$/.test(started) ? { pid, started: `windows-filetime:${started}` } : null;
  } catch {
    return null;
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

async function inspectLinuxProcess(pid: number): Promise<ProcessInstanceIdentity | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closingName = stat.lastIndexOf(')');
    if (closingName < 0) return null;
    const fields = stat.slice(closingName + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // field 22 overall; fields begin at process-state field 3.
    return startTicks ? { pid, started: `linux-boot-ticks:${startTicks}` } : null;
  } catch {
    return null;
  }
}

async function inspectPortableProcess(pid: number): Promise<ProcessInstanceIdentity | null> {
  try {
    process.kill(pid, 0);
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5_000, maxBuffer: 16 * 1024, encoding: 'utf8' });
    const started = stdout.trim();
    return started ? { pid, started: `ps-lstart:${started}` } : null;
  } catch {
    return null;
  }
}
