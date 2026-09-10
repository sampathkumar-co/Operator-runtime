import crypto from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OperatorError } from './errors.ts';

export interface DurableStateOptions {
  maxBytes: number;
  errorCode: string;
  invalidMessage: string;
}

export async function readDurableStateText(file: string, options: DurableStateOptions): Promise<string> {
  return (await readDurableStateBytes(file, options)).toString('utf8');
}

class DurableStateReadRace extends Error {}

export async function readDurableStateBytes(file: string, options: DurableStateOptions): Promise<Buffer> {
  validateOptions(options);
  let lastRace: DurableStateReadRace | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await readDurableStateBytesOnce(file, options);
    } catch (error) {
      if (!(error instanceof DurableStateReadRace)) throw error;
      lastRace = error;
    }
  }
  throw invalid(options, lastRace?.message ?? 'State file changed while it was being read.');
}

async function readDurableStateBytesOnce(file: string, options: DurableStateOptions): Promise<Buffer> {
  const initial = await fs.lstat(file);
  assertStableRegular(initial, options);

  const noFollow = process.platform === 'win32'
    ? 0
    : Number((fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw invalid(options, 'Symbolic links are not permitted.');
    if (code === 'ENOENT') throw new DurableStateReadRace('State file changed while it was being opened.');
    throw error;
  }

  try {
    const opened = await handle.stat();
    assertOpenedRegular(opened, options, 'State file changed while it was being opened.');
    if (!sameFile(initial, opened)) throw new DurableStateReadRace('State file changed while it was being opened.');

    const bytes = await handle.readFile();
    if (bytes.byteLength > options.maxBytes) throw invalid(options, 'State file exceeds the bounded size.');
    const afterRead = await handle.stat();
    assertOpenedRegular(afterRead, options, 'State file changed while it was being read.');
    if (!sameFile(opened, afterRead) || opened.size !== afterRead.size || opened.mtimeMs !== afterRead.mtimeMs || opened.ctimeMs !== afterRead.ctimeMs) {
      throw new DurableStateReadRace('State file changed while it was being read.');
    }

    let current: Stats;
    try {
      current = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DurableStateReadRace('State file path changed while it was being read.');
      throw error;
    }
    assertStableRegular(current, options);
    if (!sameFile(afterRead, current)) throw new DurableStateReadRace('State file path changed while it was being read.');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function appendDurableStateText(file: string, content: string, options: DurableStateOptions): Promise<void> {
  validateOptions(options);
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength < 1 || byteLength > options.maxBytes) throw invalid(options, 'Appended state content is empty or exceeds the bounded size.');

  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  let initial: Stats | null = null;
  try {
    initial = await fs.lstat(file);
    assertStableRegular(initial, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const noFollow = process.platform === 'win32'
    ? 0
    : Number((fsConstants as unknown as Record<string, number>).O_NOFOLLOW ?? 0);
  let handle;
  let created = false;
  try {
    if (initial) {
      handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow);
    } else {
      handle = await fs.open(file, 'wx', 0o600);
      created = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid(options, 'Symbolic links are not permitted.');
    throw error;
  }

  try {
    const opened = await handle.stat();
    assertStableRegular(opened, options);
    if (initial && !sameFile(initial, opened)) throw invalid(options, 'State file changed while it was being opened for append.');

    const current = await fs.lstat(file);
    assertStableRegular(current, options);
    if (!sameFile(opened, current)) throw invalid(options, 'State file path changed before append.');
    if (opened.size + byteLength > options.maxBytes) throw invalid(options, 'State file would exceed the bounded size after append.');

    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();

    const appended = await handle.stat();
    assertStableRegular(appended, options);
    if (!sameFile(opened, appended) || appended.size !== opened.size + byteLength) {
      throw invalid(options, 'State append did not produce the expected file size.');
    }
    const committed = await fs.lstat(file);
    assertStableRegular(committed, options);
    if (!sameFile(appended, committed)) throw invalid(options, 'State file path changed during append.');
  } finally {
    await handle.close();
  }

  if (created && process.platform !== 'win32') await syncDirectory(directory);
}

export async function writeDurableStateText(file: string, content: string, options: DurableStateOptions): Promise<void> {
  await writeDurableStateBytes(file, Buffer.from(content, 'utf8'), options);
}

export async function writeDurableStateBytes(file: string, content: Uint8Array, options: DurableStateOptions): Promise<void> {
  validateOptions(options);
  const bytes = Buffer.from(content);
  const byteLength = bytes.byteLength;
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
      await handle.writeFile(bytes);
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

    if (process.platform !== 'win32') await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function createDurableStateBytes(file: string, content: Uint8Array, options: DurableStateOptions): Promise<void> {
  validateOptions(options);
  const bytes = Buffer.from(content);
  const byteLength = bytes.byteLength;
  if (byteLength > options.maxBytes) throw invalid(options, 'Serialized state exceeds the bounded size.');

  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(file);
    assertStableRegular(existing, options);
    const exists = new Error('State file already exists.') as NodeJS.ErrnoException;
    exists.code = 'EEXIST';
    throw exists;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  let published = false;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }

    const staged = await fs.lstat(temp);
    assertStableRegular(staged, options);
    if (staged.size !== byteLength) throw invalid(options, 'Staged state size did not match the serialized state.');

    await fs.link(temp, file);
    published = true;
    await fs.rm(temp);

    const committed = await fs.lstat(file);
    assertStableRegular(committed, options);
    if (committed.size !== byteLength) throw invalid(options, 'Committed state size did not match the serialized state.');

    if (process.platform !== 'win32') await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (published) {
      try {
        const committed = await fs.lstat(file);
        assertStableRegular(committed, options);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
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

function assertOpenedRegular(stat: Stats, options: DurableStateOptions, raceMessage: string): void {
  if (!stat.isFile()) throw invalid(options, 'Opened state path must be a regular file.');
  if (stat.nlink > 1) throw invalid(options, 'Hard-linked state files are not permitted.');
  if (stat.nlink < 1) throw new DurableStateReadRace(raceMessage);
  if (stat.size > options.maxBytes) throw invalid(options, 'State file exceeds the bounded size.');
}

function assertStableRegular(stat: Stats, options: DurableStateOptions): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw invalid(options, 'State path must be a regular file, not a link or special file.');
  if (stat.nlink !== 1) throw invalid(options, 'Hard-linked state files are not permitted.');
  if (stat.size > options.maxBytes) throw invalid(options, 'State file exceeds the bounded size.');
}

function sameFile(left: Stats, right: Stats): boolean {
  // Node 22 on Windows can report dev=0 for path stat/lstat while the same
  // file opened by handle reports the NT volume serial as dev. The file index
  // (ino) remains stable across both views, so use that as the fail-closed
  // identity on Windows and keep the POSIX dev+ino pair elsewhere.
  if (process.platform === 'win32') return left.ino !== 0 && right.ino !== 0 && left.ino === right.ino;
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateOptions(options: DurableStateOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !options.errorCode || !options.invalidMessage) {
    throw new OperatorError('DURABLE_STATE_CONFIGURATION_INVALID', 'Durable-state file options are invalid.');
  }
}

function invalid(options: DurableStateOptions, detail: string): OperatorError {
  return new OperatorError(options.errorCode, `${options.invalidMessage} ${detail}`);
}
