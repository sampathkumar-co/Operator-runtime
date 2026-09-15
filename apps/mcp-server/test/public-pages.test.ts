import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPublicServicePages, PUBLIC_NOTICES_FINAL_ACK } from '../src/public-pages.ts';

function writeFixture(dir: string): void {
  writeFileSync(path.join(dir, 'privacy.md'), '# Production Privacy\nController: SPLCART\nRetention: 24 hours.');
  writeFileSync(path.join(dir, 'terms.md'), '# Production Terms\nEffective for the deployed Operator service.');
  writeFileSync(path.join(dir, 'support.md'), '# Production Support\nContact: support@example.invalid\nSecurity: private channel configured.');
}

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'operator-public-notices-'));
  writeFixture(dir);
  return dir;
}

function directoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function env(dir: string): NodeJS.ProcessEnv {
  return {
    OPERATOR_PUBLIC_NOTICES_DIR: dir,
    OPERATOR_PUBLIC_NOTICES_FINAL_ACK: PUBLIC_NOTICES_FINAL_ACK
  };
}

test('finalized public notices load from fixed deployment files and escape HTML', () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, 'privacy.md'), '# Production Privacy\n<script>alert(1)</script>');
    const pages = loadPublicServicePages(env(dir));
    assert.match(pages['/'], /SPLCART Operator/);
    assert.match(pages['/'], /href="\/privacy"/);
    assert.match(pages['/privacy'], /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(pages['/privacy'], /<script>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public notices fail closed without final acknowledgement or an absolute directory', () => {
  const dir = fixture();
  try {
    assert.throws(() => loadPublicServicePages({ OPERATOR_PUBLIC_NOTICES_DIR: dir }), /FINAL_ACK/);
    assert.throws(() => loadPublicServicePages({
      OPERATOR_PUBLIC_NOTICES_DIR: 'relative/notices',
      OPERATOR_PUBLIC_NOTICES_FINAL_ACK: PUBLIC_NOTICES_FINAL_ACK
    }), /absolute directory/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repository draft notice language is rejected before public-edge startup', () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, 'terms.md'), '**Status:** launch draft; becomes effective only when published.');
    assert.throws(() => loadPublicServicePages(env(dir)), /repository-draft language/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('symlinked notice directory is rejected even with a trailing separator', (t) => {
  const target = fixture();
  const parent = mkdtempSync(path.join(tmpdir(), 'operator-public-notices-link-'));
  const link = path.join(parent, 'linked');
  try {
    try { directoryLink(target, link); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('directory links unavailable on this runner'); return; }
      throw error;
    }
    assert.throws(() => loadPublicServicePages(env(`${link}${path.sep}`)), /linked path components|resolve to itself/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('notice directory rejects a linked ancestor component', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'operator-public-notices-ancestor-'));
  const realParent = path.join(root, 'real-parent');
  const notices = path.join(realParent, 'notices');
  const alias = path.join(root, 'alias-parent');
  mkdirSync(notices, { recursive: true });
  writeFixture(notices);
  try {
    try { directoryLink(realParent, alias); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('directory links unavailable on this runner'); return; }
      throw error;
    }
    assert.throws(() => loadPublicServicePages(env(path.join(alias, 'notices'))), /linked path components|resolve to itself/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('notice reads remain intrinsically bounded by the opened descriptor', () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, 'privacy.md'), Buffer.alloc(256 * 1024 + 1, 0x61));
    assert.throws(() => loadPublicServicePages(env(dir)), /between 1 and 262144 bytes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('linked notice file is rejected before target bytes can become public content', (t) => {
  const dir = fixture();
  const outside = path.join(mkdtempSync(path.join(tmpdir(), 'operator-public-notice-target-')), 'outside.md');
  try {
    writeFileSync(outside, '# Outside Secret Notice');
    rmSync(path.join(dir, 'privacy.md'));
    try { symlinkSync(outside, path.join(dir, 'privacy.md'), 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlinks unavailable on this runner'); return; }
      throw error;
    }
    assert.throws(() => loadPublicServicePages(env(dir)), /regular notice file|changed during notice validation|ELOOP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});
