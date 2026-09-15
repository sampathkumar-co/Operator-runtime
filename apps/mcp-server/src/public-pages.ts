import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLIC_SERVICE_PAGE_PATHS = ['/privacy', '/terms', '/support'] as const;
export type PublicServicePagePath = typeof PUBLIC_SERVICE_PAGE_PATHS[number];

const PAGE_SOURCES: Record<PublicServicePagePath, { title: string; source: string }> = {
  '/privacy': { title: 'SPLCART Operator Privacy', source: '../../../PRIVACY.md' },
  '/terms': { title: 'SPLCART Operator Terms of Service', source: '../../../TERMS.md' },
  '/support': { title: 'SPLCART Operator Support', source: '../../../SUPPORT.md' }
};

export function renderPublicServicePage(path: PublicServicePagePath): string {
  const page = PAGE_SOURCES[path];
  const sourceUrl = new URL(page.source, import.meta.url);
  const markdown = readFileSync(fileURLToPath(sourceUrl), 'utf8');
  return renderDocument(page.title, markdown);
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
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.7 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;border:1px solid #e2e5e9;border-radius:14px;padding:32px;box-shadow:0 12px 30px rgba(0,0,0,.05)}
@media(prefers-color-scheme:dark){body{background:#111318;color:#f0f2f5}pre{background:#181b20;border-color:#2a2f37;box-shadow:none}}
@media(max-width:640px){main{padding:20px 12px 40px}pre{padding:20px;border-radius:10px}}
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
