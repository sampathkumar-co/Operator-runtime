import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { OperatorError } from './errors.ts';
import { safeChildEnvironment } from './child-environment.ts';

const READY_TIMEOUT_MS = 5_000;
const RELEASE_TIMEOUT_MS = 5_000;
const MAX_HELPER_TEXT_BYTES = 4 * 1024;

export type WindowsPathLeaseMode = 'existing' | 'parent';

export interface WindowsPathLeaseOptions {
  root: string;
  target: string;
  mode: WindowsPathLeaseMode;
  executable?: string;
}

export async function withWindowsPathLease<T>(
  options: WindowsPathLeaseOptions,
  operation: () => Promise<T>
): Promise<T> {
  if (process.platform !== 'win32') return await operation();
  const executable = options.executable ?? process.env.OPERATOR_WINDOWS_PATH_LEASE_PATH;
  if (!executable || !path.isAbsolute(executable)) {
    throw new OperatorError(
      'WINDOWS_PATH_LEASE_HELPER_REQUIRED',
      'Windows filesystem operations require the packaged path-lease helper.'
    );
  }
  const child = spawn(executable, ['lease', options.mode, options.root, options.target], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeChildEnvironment('windows-native')
  });
  await waitForReady(child);

  let value: T | undefined;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    await releaseLease(child);
  } catch (error) {
    releaseError = error;
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return value as T;
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: OperatorError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.once('error', () => finish(new OperatorError(
      'WINDOWS_PATH_LEASE_HELPER_FAILED',
      'Windows path-lease helper could not be started.'
    )));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr, 'utf8') >= MAX_HELPER_TEXT_BYTES) return;
      stderr = (stderr + chunk).slice(0, MAX_HELPER_TEXT_BYTES);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_HELPER_TEXT_BYTES) {
        finish(new OperatorError('WINDOWS_PATH_LEASE_HELPER_FAILED', 'Windows path-lease helper returned invalid output.'));
        return;
      }
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      if (stdout.slice(0, newline).trim() !== 'READY') {
        finish(new OperatorError('WINDOWS_PATH_LEASE_DENIED', 'Windows path authority validation failed.'));
        return;
      }
      finish();
    });
    child.once('close', (code) => {
      if (!settled) finish(new OperatorError(
        'WINDOWS_PATH_LEASE_DENIED',
        code === 0
          ? 'Windows path-lease helper exited before establishing authority.'
          : 'Windows path authority validation failed.'
      ));
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new OperatorError('WINDOWS_PATH_LEASE_TIMEOUT', 'Windows path authority validation timed out.'));
    }, READY_TIMEOUT_MS);
    timer.unref();
  });
}

async function releaseLease(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode === 0) return;
    throw new OperatorError('WINDOWS_PATH_LEASE_HELPER_FAILED', 'Windows path-lease helper exited unexpectedly.');
  }
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: OperatorError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.once('error', () => finish(new OperatorError(
      'WINDOWS_PATH_LEASE_HELPER_FAILED',
      'Windows path-lease helper failed while releasing authority.'
    )));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new OperatorError('WINDOWS_PATH_LEASE_HELPER_FAILED', 'Windows path-lease helper failed while releasing authority.'));
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new OperatorError('WINDOWS_PATH_LEASE_TIMEOUT', 'Windows path-lease helper did not release authority in time.'));
    }, RELEASE_TIMEOUT_MS);
    timer.unref();
  });
}
