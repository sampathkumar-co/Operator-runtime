from pathlib import Path
import re


def patch_imports(path: str, *, remove_fs: bool = True, remove_crypto: bool = False) -> str:
    p = Path(path)
    s = p.read_text()
    if remove_fs:
        s = s.replace("import fs from 'node:fs/promises';\n", '', 1)
    if remove_crypto:
        s = s.replace("import crypto from 'node:crypto';\n", '', 1)
    anchor = "import { OperatorError } from './errors.ts';\n"
    if s.count(anchor) != 1:
        raise SystemExit(f'{path}: OperatorError import anchor mismatch: {s.count(anchor)}')
    return s.replace(anchor, anchor + "import { readDurableStateText, writeDurableStateText } from './durable-state.ts';\n", 1)


def patch_store(path: str, state_type: str, code: str, invalid_message: str, read_failure_message: str,
                max_bytes: str, empty_state: str, write_param: str, *, remove_crypto: bool = False) -> None:
    p = Path(path)
    s = patch_imports(path, remove_fs=True, remove_crypto=remove_crypto)
    pattern = rf"  async #read\(\): Promise<{re.escape(state_type)}> \{{.*?^  \}}\n\n  async #write\([^\n]+\): Promise<void> \{{.*?^  \}}\n\n  async #mutate"
    replacement = f"""  async #read(): Promise<{state_type}> {{
    try {{
      const text = await readDurableStateText(this.#file, {{
        maxBytes: {max_bytes},
        errorCode: '{code}',
        invalidMessage: '{invalid_message}'
      }});
      return validateState(JSON.parse(text));
    }} catch (error) {{
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {empty_state};
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('{code}', '{read_failure_message}');
    }}
  }}

  async #write({write_param}: {state_type}): Promise<void> {{
    const state = validateState({write_param});
    await writeDurableStateText(this.#file, JSON.stringify(state, null, 2), {{
      maxBytes: {max_bytes},
      errorCode: '{code}',
      invalidMessage: '{invalid_message}'
    }});
  }}

  async #mutate"""
    new, count = re.subn(pattern, replacement, s, count=1, flags=re.S | re.M)
    if count != 1:
        raise SystemExit(f'{path}: read/write state block mismatch: {count}')
    p.write_text(new)


helper = """import crypto from 'node:crypto';
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
"""
Path('src/core/durable-state.ts').write_text(helper)

patch_store('src/core/device-registry.ts', 'RegistryState', 'DEVICE_REGISTRY_CORRUPT',
            'Device registry is invalid.', 'Device registry could not be read.', '2 * 1024 * 1024',
            '{ version: 1, devices: [], challenges: [] }', 'state')
patch_store('src/core/account-device-registry.ts', 'AccountDeviceState', 'ACCOUNT_STATE_CORRUPT',
            'Account-device registry is invalid.', 'Account-device registry could not be read.', '32 * 1024 * 1024',
            '{ version: 1, accounts: [], memberships: [] }', 'stateInput')
patch_store('src/core/session-token.ts', 'SessionState', 'SESSION_STATE_CORRUPT',
            'Session registry is invalid.', 'Session registry could not be read.', '2 * 1024 * 1024',
            '{ version: 1, issued: [] }', 'state')
patch_store('src/core/relay-delivery-store.ts', 'RelayDeliveryState', 'RELAY_QUEUE_CORRUPT',
            'Relay delivery state is invalid.', 'Relay delivery state could not be read.', '128 * 1024 * 1024',
            '{ version: 1, streams: [] }', 'stateInput')
patch_store('src/core/relay-result-store.ts', 'ResultState', 'RELAY_RESULT_STATE_CORRUPT',
            'Relay result state is invalid.', 'Relay result state could not be read.', '256 * 1024 * 1024',
            '{ version: 1, streams: [] }', 'stateInput')
patch_store('src/core/device-routing.ts', 'RoutingState', 'ROUTE_STATE_CORRUPT',
            'Device routing state is invalid.', 'Device routing state could not be read.', '512 * 1024',
            '{ version: 1, bindings: [] }', 'stateInput', remove_crypto=True)

# Relay client uses #readState/#writeState.
p = Path('src/core/relay-client.ts')
s = p.read_text().replace("import fs from 'node:fs/promises';\n", '', 1)
anchor = "import { OperatorError } from './errors.ts';\n"
if s.count(anchor) != 1:
    raise SystemExit('relay-client: OperatorError import mismatch')
s = s.replace(anchor, anchor + "import { readDurableStateText, writeDurableStateText } from './durable-state.ts';\n", 1)
pattern = r"  async #readState\(\): Promise<RelayState> \{.*?^  \}\n\n  async #writeState\(stateInput: RelayState\): Promise<void> \{.*?^  \}\n"
replacement = """  async #readState(): Promise<RelayState> {
    try {
      const text = await readDurableStateText(this.#stateFile, {
        maxBytes: 64 * 1024,
        errorCode: 'RELAY_STATE_CORRUPT',
        invalidMessage: 'Relay client state is invalid.'
      });
      return validateState(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, lastAckedServerSeq: 0 };
      if (error instanceof OperatorError) throw error;
      throw new OperatorError('RELAY_STATE_CORRUPT', 'Relay client state could not be read.');
    }
  }

  async #writeState(stateInput: RelayState): Promise<void> {
    const state = validateState(stateInput);
    await writeDurableStateText(this.#stateFile, JSON.stringify(state, null, 2), {
      maxBytes: 64 * 1024,
      errorCode: 'RELAY_STATE_CORRUPT',
      invalidMessage: 'Relay client state is invalid.'
    });
  }
"""
s, count = re.subn(pattern, replacement, s, count=1, flags=re.S | re.M)
if count != 1:
    raise SystemExit(f'relay-client: state block mismatch {count}')
p.write_text(s)

# Device identity gets no-follow bounded reads and durable atomic migration writes.
p = Path('src/core/device-identity.ts')
s = p.read_text()
anchor = "import { OperatorError } from './errors.ts';\n"
if s.count(anchor) != 1:
    raise SystemExit('device-identity: OperatorError import mismatch')
s = s.replace(anchor, anchor + "import { readDurableStateText, writeDurableStateText } from './durable-state.ts';\n", 1)
old = "    const raw = await fs.readFile(this.#file, 'utf8');\n    if (Buffer.byteLength(raw, 'utf8') > MAX_IDENTITY_BYTES) {\n      throw new OperatorError('DEVICE_IDENTITY_INVALID', 'Device identity file exceeds the allowed size.');\n    }"
new = "    const raw = await readDurableStateText(this.#file, {\n      maxBytes: MAX_IDENTITY_BYTES,\n      errorCode: 'DEVICE_IDENTITY_INVALID',\n      invalidMessage: 'Device identity file is invalid.'\n    });"
if s.count(old) != 1:
    raise SystemExit(f'device-identity: read anchor mismatch {s.count(old)}')
s = s.replace(old, new, 1)
pattern = r"async function replaceJsonAtomic\(file: string, value: StoredIdentity\): Promise<void> \{.*?^\}\n"
replacement = """async function replaceJsonAtomic(file: string, value: StoredIdentity): Promise<void> {
  await writeDurableStateText(file, JSON.stringify(value, null, 2), {
    maxBytes: MAX_IDENTITY_BYTES,
    errorCode: 'DEVICE_IDENTITY_INVALID',
    invalidMessage: 'Device identity file is invalid.'
  });
}
"""
s, count = re.subn(pattern, replacement, s, count=1, flags=re.S | re.M)
if count != 1:
    raise SystemExit(f'device-identity: atomic replace mismatch {count}')
p.write_text(s)

# Keep listIssued bounded even for NaN/Infinity input while touching this store.
p = Path('src/core/session-token.ts')
s = p.read_text()
old = "    const bounded = Math.min(Math.max(Number(limit), 1), 500);"
new = "    const parsedLimit = Number(limit);\n    const bounded = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500) : 100;"
if s.count(old) != 1:
    raise SystemExit(f'session-token: list limit anchor mismatch {s.count(old)}')
p.write_text(s.replace(old, new, 1))


test_source = """import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDurableStateText, writeDurableStateText } from '../src/core/durable-state.ts';
import { RelayDeliveryStore } from '../src/core/relay-delivery-store.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

const options = {
  maxBytes: 64 * 1024,
  errorCode: 'TEST_STATE_INVALID',
  invalidMessage: 'Test durable state is invalid.'
} as const;

async function makeFileSymlinkOrSkip(t: test.TestContext, target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`file symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

test('durable state refuses symlink reads and replacement writes without touching the target', async (t) => {
  const root = await tempDir(t, 'operator-durable-state-');
  const outside = path.join(root, 'outside.json');
  const link = path.join(root, 'state.json');
  await fs.writeFile(outside, '{"secret":"unchanged"}\\n', { mode: 0o600 });
  if (!(await makeFileSymlinkOrSkip(t, outside, link))) return;

  await assert.rejects(() => readDurableStateText(link, options), (error: any) => error?.code === 'TEST_STATE_INVALID');
  await assert.rejects(() => writeDurableStateText(link, '{"new":true}\\n', options), (error: any) => error?.code === 'TEST_STATE_INVALID');
  assert.equal(await fs.readFile(outside, 'utf8'), '{"secret":"unchanged"}\\n');
});

test('durable state atomic write commits exact bytes and leaves no temporary state files', async (t) => {
  const root = await tempDir(t, 'operator-durable-write-');
  const file = path.join(root, 'state.json');
  const content = '{"version":1,"value":"ok"}\\n';
  await writeDurableStateText(file, content, options);
  assert.equal(await readDurableStateText(file, options), content);
  assert.deepEqual(await fs.readdir(root), ['state.json']);
  const stat = await fs.lstat(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
});

test('relay delivery store refuses a symlinked authority-bearing queue file', async (t) => {
  const root = await tempDir(t, 'operator-relay-state-link-');
  const outside = path.join(root, 'outside-relay.json');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  await fs.writeFile(outside, JSON.stringify({ version: 1, streams: [] }), { mode: 0o600 });
  const link = path.join(stateDir, 'relay-deliveries.json');
  if (!(await makeFileSymlinkOrSkip(t, outside, link))) return;
  const store = new RelayDeliveryStore(stateDir);
  await assert.rejects(
    () => store.pending('11111111-1111-4111-8111-111111111111'),
    (error: any) => error?.code === 'RELAY_QUEUE_CORRUPT'
  );
});

test('all authority-bearing JSON stores use the durable state boundary', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    'src/core/device-registry.ts',
    'src/core/account-device-registry.ts',
    'src/core/session-token.ts',
    'src/core/relay-delivery-store.ts',
    'src/core/relay-result-store.ts',
    'src/core/device-routing.ts',
    'src/core/relay-client.ts'
  ];
  for (const relative of files) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    assert.match(source, /readDurableStateText/);
    assert.match(source, /writeDurableStateText/);
    assert.doesNotMatch(source, /fs\\.stat\\(this\\.#(?:file|stateFile)\\)/);
  }
  const identity = await fs.readFile(path.join(root, 'src/core/device-identity.ts'), 'utf8');
  assert.match(identity, /readDurableStateText/);
  assert.match(identity, /writeDurableStateText/);
});
"""
Path('test/durable-state-boundary-audit.test.ts').write_text(test_source)
