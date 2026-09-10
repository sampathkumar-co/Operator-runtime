import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseUpdateVerifier, type ReleaseArtifact } from '../src/core/release-update.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

function verifier(): ReleaseUpdateVerifier {
  const pair = crypto.generateKeyPairSync('ed25519');
  return new ReleaseUpdateVerifier(pair.publicKey.export({ format: 'pem', type: 'spki' }).toString());
}

function artifact(bytes: Buffer): ReleaseArtifact {
  return {
    platform: 'win32',
    arch: 'x64',
    kind: 'msix',
    url: 'https://releases.example.invalid/operator.msix',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength
  };
}

async function makeSymlinkOrSkip(t: test.TestContext, target: string, link: string, type: 'file' | 'junction'): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`symlink creation is unavailable on this runner (${code})`);
      return false;
    }
    throw error;
  }
}

test('staged update refuses a symlinked artifact even when the target has the signed bytes', async (t) => {
  const state = await tempDir(t, 'operator-update-link-state-');
  const outside = await tempDir(t, 'operator-update-link-outside-');
  const bytes = Buffer.from('signed-artifact-bytes');
  const target = path.join(outside, 'outside.msix');
  await fs.writeFile(target, bytes, { mode: 0o600 });
  const stagingDir = path.join(state, 'updates', '2.0.0');
  await fs.mkdir(stagingDir, { recursive: true });
  const link = path.join(stagingDir, 'operator-win32-x64.msix');
  if (!(await makeSymlinkOrSkip(t, target, link, 'file'))) return;

  await assert.rejects(
    verifier().verifyAndStageArtifact(artifact(bytes), bytes, state, '2.0.0'),
    (error: any) => error?.code === 'UPDATE_STAGE_INVALID'
  );
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('staged update refuses a hard-linked artifact authority file', async (t) => {
  const state = await tempDir(t, 'operator-update-hardlink-state-');
  const outside = await tempDir(t, 'operator-update-hardlink-outside-');
  const bytes = Buffer.from('signed-artifact-hardlink-bytes');
  const target = path.join(outside, 'outside.msix');
  await fs.writeFile(target, bytes, { mode: 0o600 });
  const stagingDir = path.join(state, 'updates', '2.1.0');
  await fs.mkdir(stagingDir, { recursive: true });
  const linked = path.join(stagingDir, 'operator-win32-x64.msix');
  try {
    await fs.link(target, linked);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
      t.skip(`hard-link creation is unavailable on this runner (${code})`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    verifier().verifyAndStageArtifact(artifact(bytes), bytes, state, '2.1.0'),
    (error: any) => error?.code === 'UPDATE_STAGE_INVALID'
  );
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.ok((await fs.lstat(linked)).nlink > 1);
});

test('symlinked updates directory is rejected before any version directory is created through it', async (t) => {
  const state = await tempDir(t, 'operator-update-dir-link-state-');
  const outside = await tempDir(t, 'operator-update-dir-link-outside-');
  const updates = path.join(state, 'updates');
  if (!(await makeSymlinkOrSkip(t, outside, updates, 'junction'))) return;
  const bytes = Buffer.from('signed-artifact-directory-bytes');

  await assert.rejects(
    verifier().verifyAndStageArtifact(artifact(bytes), bytes, state, '3.0.0'),
    (error: any) => error?.code === 'UPDATE_STAGE_INVALID'
  );
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await fs.lstat(updates)).isSymbolicLink(), true);
});

test('fresh update staging publishes one regular single-link file and leaves no temporary files', async (t) => {
  const state = await tempDir(t, 'operator-update-clean-stage-');
  const bytes = Buffer.from('fresh-signed-artifact-bytes');
  const result = await verifier().verifyAndStageArtifact(artifact(bytes), bytes, state, '4.0.0');

  assert.deepEqual(await fs.readFile(result.path), bytes);
  const stat = await fs.lstat(result.path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  const entries = await fs.readdir(path.dirname(result.path));
  assert.deepEqual(entries, [path.basename(result.path)]);
});
