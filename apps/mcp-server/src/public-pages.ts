import { lstatSync, readFileSync } from 'node:fs';
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
  const noticesDir = env.OPERATOR_PUBLIC_NOTICES_DIR?.trim() ?? '';
  if (!path.isAbsolute(noticesDir)) throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must be an absolute directory path.');
  const directory = lstatSync(noticesDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('OPERATOR_PUBLIC_NOTICES_DIR must be a real directory, not a link.');
  }

  const rendered = { '/': renderLandingPage() } as Record<PublicServicePagePath, string>;
  for (const pagePath of ['/privacy', '/terms', '/support'] as const) {
    const page = PAGE_SOURCES[pagePath];
    const sourcePath = path.join(noticesDir, page.file);
    const source = lstatSync(sourcePath);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error(`${page.file} must be a regular notice file.`);
    if (source.size < 1 || source.size > MAX_NOTICE_BYTES) throw new Error(`${page.file} must be between 1 and ${MAX_NOTICE_BYTES} bytes.`);
    const markdown = readFileSync(sourcePath, 'utf8');
    if (markdown.includes('\0')) throw new Error(`${page.file} contains a NUL byte.`);
    if (DRAFT_MARKERS.some((marker) => markdown.toLowerCase().includes(marker))) {
      throw new Error(`${page.file} still contains repository-draft language and cannot be published.`);
    }
    rendered[pagePath] = renderDocument(page.title, markdown);
  }
  return rendered;
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
