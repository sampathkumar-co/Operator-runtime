import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPublicServicePages, PUBLIC_NOTICES_FINAL_ACK } from '../src/public-pages.ts';

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'operator-public-notices-'));
  writeFileSync(path.join(dir, 'privacy.md'), '# Production Privacy\nController: SPLCART\nRetention: 24 hours.');
  writeFileSync(path.join(dir, 'terms.md'), '# Production Terms\nEffective for the deployed Operator service.');
  writeFileSync(path.join(dir, 'support.md'), '# Production Support\nContact: support@example.invalid\nSecurity: private channel configured.');
  return dir;
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
