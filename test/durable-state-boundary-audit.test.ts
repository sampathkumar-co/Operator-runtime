import assert from 'node:assert/strict';
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
  await fs.writeFile(outside, '{"secret":"unchanged"}\n', { mode: 0o600 });
  if (!(await makeFileSymlinkOrSkip(t, outside, link))) return;

  await assert.rejects(() => readDurableStateText(link, options), (error: any) => error?.code === 'TEST_STATE_INVALID');
  await assert.rejects(() => writeDurableStateText(link, '{"new":true}\n', options), (error: any) => error?.code === 'TEST_STATE_INVALID');
  assert.equal(await fs.readFile(outside, 'utf8'), '{"secret":"unchanged"}\n');
});

test('durable state atomic write commits exact bytes and leaves no temporary state files', async (t) => {
  const root = await tempDir(t, 'operator-durable-write-');
  const file = path.join(root, 'state.json');
  const content = '{"version":1,"value":"ok"}\n';
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
    assert.doesNotMatch(source, /fs\.stat\(this\.#(?:file|stateFile)\)/);
  }
  const identity = await fs.readFile(path.join(root, 'src/core/device-identity.ts'), 'utf8');
  assert.match(identity, /readDurableStateText/);
  assert.match(identity, /writeDurableStateText/);
});
