import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs, { type Stats } from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';

export interface DurableStateOptions {
  maxBytes: number;
  errorCode: string;
  invalidMessage: string;
}

export async function readDurableStateText(file: string, options: DurableStateOptions): Promise<string> {
  validateOptions(options);
  const initial = await fs.lstat(file);
  assertStableRegular(initial, options);

  const noFollow = process.platform === 'win32'
    ? 0
    : Number((fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid(options, 'Symbolic links are not permitted.');
    throw error;
  }

  try {
    const opened = await handle.stat();
    assertStableRegular(opened, options);
    if (!sameFile(initial, opened)) throw invalid(options, 'State file changed while it was being opened.');

    const bytes = await handle.readFile();
    if (bytes.byteLength > options.maxBytes) throw invalid(options, 'State file exceeds the bounded size.');
    const afterRead = await handle.stat();
    assertStableRegular(afterRead, options);
    if (!sameFile(opened, afterRead) || opened.size !== afterRead.size || opened.mtimeMs !== afterRead.mtimeMs || opened.ctimeMs !== afterRead.ctimeMs) {
      throw invalid(options, 'State file changed while it was being read.');
    }

    const current = await fs.lstat(file);
    assertStableRegular(current, options);
    if (!sameFile(afterRead, current)) throw invalid(options, 'State file path changed while it was being read.');
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeDurableStateText(file: string, content: string, options: DurableStateOptions): Promise<void> {
  validateOptions(options);
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > options.maxBytes) throw invalid(options, 'Serialized state exceeds the bounded size.');

  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertReplaceTarget(file, options);

  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }

    const staged = await fs.lstat(temp);
    assertStableRegular(staged, options);
    if (staged.size !== byteLength) throw invalid(options, 'Staged state size did not match the serialized state.');

    await assertReplaceTarget(file, options);
    await fs.rename(temp, file);
    renamed = true;

    const committed = await fs.lstat(file);
    assertStableRegular(committed, options);
    if (committed.size !== byteLength) throw invalid(options, 'Committed state size did not match the serialized state.');

    if (process.platform !== 'win32') {
      const directoryHandle = await fs.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function assertReplaceTarget(file: string, options: DurableStateOptions): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    assertStableRegular(stat, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function assertStableRegular(stat: Stats, options: DurableStateOptions): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw invalid(options, 'State path must be a regular file, not a link or special file.');
  if (stat.nlink !== 1) throw invalid(options, 'Hard-linked state files are not permitted.');
  if (stat.size > options.maxBytes) throw invalid(options, 'State file exceeds the bounded size.');
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateOptions(options: DurableStateOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !options.errorCode || !options.invalidMessage) {
    throw new OperatorError('DURABLE_STATE_CONFIGURATION_INVALID', 'Durable-state file options are invalid.');
  }
}

function invalid(options: DurableStateOptions, detail: string): OperatorError {
  return new OperatorError(options.errorCode, `${options.invalidMessage} ${detail}`);
}
