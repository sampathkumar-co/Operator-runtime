import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const PUBLIC_SERVICE_PAGE_PATHS = ['/', '/privacy', '/terms', '/support'] as const;
export type PublicServicePagePath = typeof PUBLIC_SERVICE_PAGE_PATHS[number];
type SourcePagePath = Exclude<PublicServicePagePath, '/'>;

export const PUBLIC_NOTICES_FINAL_ACK = 'I_CONFIRM_OPERATOR_PUBLIC_NOTICES_ARE_FINAL';
const MAX_NOTICE_BYTES = 256 * 1024;
const PAGE_SOURCES: Record<SourcePagePath, { title: string; file: string }> = {
  '/privacy': { title: 'SPLCART Operator Privacy', file: 'privacy.md' },
  '/terms': { title: 'SPLCART Operator Terms of Service', file: 'terms.md' },
  '/support': { title: 'SPLCART Operator Support', file: 'support.md' }
};
const DRAFT_MARKERS = [
  'open-source/reference runtime',
  'must additionally publish deployment-specific',
  '**status:** launch draft',
  'source draft and must not be represented as final',
  'production support page must provide a dedicated private security-reporting path'
] as const;

export function loadPublicServicePages(env: NodeJS.ProcessEnv = process.env): Record<PublicServicePagePath, string> {
  if (env.OPERATOR_PUBLIC_NOTICES_FINAL_ACK?.trim() !== PUBLIC_NOTICES_FINAL_ACK) {
    throw new Error(`Public edge requires OPERATOR_PUBLIC_NOTICES_FINAL_ACK=${PUBLIC_NOTICES_FINAL_ACK}.`);
  }
  const noticesDir = validateNoticeDirectory(env.OPERATOR_PUBLIC_NOTICES_DIR?.trim() ?? '');

  const rendered = { '/': renderLandingPage() } as Record<PublicServicePagePath, string>;
  for (const pagePath of ['/privacy', '/terms', '/support'] as const) {
    const page = PAGE_SOURCES[pagePath];
    const markdown = readNoticeFile(noticesDir, page.file);
    if (markdown.includes('\0')) throw new Error(`${page.file} contains a NUL byte.`);
    if (DRAFT_MARKERS.some((marker) => markdown.toLowerCase().includes(marker))) {
      throw new Error(`${page.file} still contains repository-draft language and cannot be published.`);
    }
    rendered[pagePath] = renderDocument(page.title, markdown);
  }
  return rendered;
}

function validateNoticeDirectory(configured: string): string {
  if (!path.isAbsolute(configured)) throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must be an absolute directory path.');
  const normalized = path.resolve(configured);
  const root = path.parse(normalized).root;
  let current = root;
  for (const segment of normalized.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must not contain linked path components.');
  }
  const directory = lstatSync(normalized);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must be a real directory, not a link.');
  }
  const real = realpathSync.native(normalized);
  if (!samePath(real, normalized)) throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must resolve to itself without links.');
  return normalized;
}

function readNoticeFile(noticesDir: string, file: string): string {
  const sourcePath = path.join(noticesDir, file);
  const before = lstatSync(sourcePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${file} must be a regular notice file.`);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(sourcePath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStableFile(before, opened)) throw new Error(`${file} changed during notice validation.`);
    assertPathStillNamesOpenedFile(sourcePath, file, opened);
    validateNoticeSize(file, opened.size);
    const markdown = readBoundedUtf8(fd, file);
    const after = fstatSync(fd, { bigint: true });
    if (!sameStableFile(opened, after)) throw new Error(`${file} changed while it was being read.`);
    assertPathStillNamesOpenedFile(sourcePath, file, after);
    validateNoticeDirectory(noticesDir);
    return markdown;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertPathStillNamesOpenedFile(sourcePath: string, file: string, opened: import('node:fs').BigIntStats): void {
  const current = lstatSync(sourcePath, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !sameStableFile(opened, current)) {
    throw new Error(`${file} changed path authority during notice validation.`);
  }
}

function validateNoticeSize(file: string, size: bigint): void {
  if (size < 1n || size > BigInt(MAX_NOTICE_BYTES)) throw new Error(`${file} must be between 1 and ${MAX_NOTICE_BYTES} bytes.`);
}

function readBoundedUtf8(fd: number, file: string): string {
  const buffer = Buffer.allocUnsafe(MAX_NOTICE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = readSync(fd, buffer, total, buffer.length - total, null);
    if (count === 0) break;
    total += count;
  }
  if (total < 1 || total > MAX_NOTICE_BYTES) throw new Error(`${file} must be between 1 and ${MAX_NOTICE_BYTES} bytes.`);
  return buffer.subarray(0, total).toString('utf8');
}

function sameFileIdentity(a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean {
  return a.ino === b.ino && (process.platform === 'win32' || a.dev === b.dev);
}

function sameStableFile(a: import('node:fs').BigIntStats, b: import('node:fs').BigIntStats): boolean {
  return sameFileIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => path.normalize(value).replace(/[\\/]+$/, '') || path.parse(value).root;
  const left = normalize(a);
  const right = normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function renderDocument(title: string, markdown: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(markdown.replace(/^\uFEFF/, '').trim());
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${safeTitle}</title>\n<style>${PAGE_CSS}</style>\n</head>\n<body>\n<main><pre>${safeBody}</pre></main>\n</body>\n</html>\n`;
}

const PAGE_CSS = `
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;background:#f6f7f9;color:#17191d}
main{max-width:900px;margin:0 auto;padding:48px 24px 72px}
section,pre{margin:0;background:#fff;border:1px solid #e2e5e9;border-radius:14px;padding:32px;box-shadow:0 12px 30px rgba(0,0,0,.05)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.7 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
h1{margin:0 0 12px;font-size:32px}p{font-size:16px;line-height:1.65}nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:24px}a{color:inherit;font-weight:650}
@media(prefers-color-scheme:dark){body{background:#111318;color:#f0f2f5}section,pre{background:#181b20;border-color:#2a2f37;box-shadow:none}}
@media(max-width:640px){main{padding:20px 12px 40px}section,pre{padding:20px;border-radius:10px}}
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderLandingPage(): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>SPLCART Operator</title>\n<style>${PAGE_CSS}</style>\n</head>\n<body>\n<main><section><h1>SPLCART Operator</h1><p>Secure, user-authorized computer operations from ChatGPT through a paired local runtime.</p><nav><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></nav></section></main>\n</body>\n</html>\n`;
}
