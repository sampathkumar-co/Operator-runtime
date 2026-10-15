// Read-only, machine-pinned *headed* Playwright visual audit of the source Control Center UI.
// This is a synthetic local fixture, not authentication or a production UI integration test.
// No remote network requests or live approvals/tasks are permitted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const actualHost = os.hostname().toUpperCase();
const ciSyntheticOnly = process.env.GITHUB_ACTIONS === 'true'
  && process.env.MECORD_VISUAL_CI_SYNTHETIC === '1';
if (!ciSyntheticOnly) assert.equal(actualHost, 'LAPTOP-GKKTT227',
  'Physical audit reserved for LAPTOP-GKKTT227; CI synthetic run does not certify the laptop.');

const root = process.cwd();
const uiDir = path.join(root, 'apps', 'control-center', 'src');
const sources = await Promise.all([
  fs.readFile(path.join(uiDir, 'shell.html'), 'utf8'),
  fs.readFile(path.join(uiDir, 'styles.css'), 'utf8'),
  fs.readFile(path.join(uiDir, 'app.js'), 'utf8')
]);
const [shell, style, script] = sources;
const hash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
assert.equal(hash.status, 0, 'A valid Operator-runtime Git checkout is required.');
const sourceCommit = hash.stdout.trim();
for (const marker of ['__MECORD_NONCE__', '__MECORD_STYLE__', '__MECORD_SCRIPT__']) {
  assert.ok(shell.includes(marker), 'Expected Control Center source marker ' + marker);
}
const html = shell
  .replace('__MECORD_NONCE__', 'synthetic-audit-only')
  .replace('__MECORD_STYLE__', style)
  .replace('__MECORD_SCRIPT__', script);

let chromium;
try {
  ({ chromium } = process.env.MECORD_VISUAL_PLAYWRIGHT_PATH
    ? await import(pathToFileURL(process.env.MECORD_VISUAL_PLAYWRIGHT_PATH).href)
    : await import('playwright'));
} catch {
  throw new Error('Playwright is not installed in this audit checkout. Install playwright in an isolated test environment before running.');
}

const browserPath = process.env.MECORD_VISUAL_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
await fs.access(browserPath);
const output = process.env.MECORD_VISUAL_ARTIFACT_DIR ||
  path.join(os.tmpdir(), 'mecord-gkktt227-visual-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
await fs.mkdir(output, { recursive: true });

const failures = [];
const consoles = [];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];
const tabs = ['tasks', 'approvals', 'recovery', 'onboarding', 'activity', 'devices',
  'policies', 'knowledge', 'diagnostics', 'teams', 'studio', 'desired', 'goals'];
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: ciSyntheticOnly,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking']
});
const results = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      recordVideo: { dir: path.join(output, 'videos'), size: { width: viewport.width, height: viewport.height } }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    page.on('pageerror', e => consoles.push({ viewport: viewport.name, kind: 'pageerror', message: e.message }));
    page.on('console', m => { if (m.type() === 'error') consoles.push({ viewport: viewport.name, kind: 'console', message: m.text() }); });
    // No external requests: synthetic page has no authentication, live sessions or privileged API connection.
    await page.route('**/*', async route => {
      failures.push({ viewport: viewport.name, type: 'unexpected-network-request',
        url: route.request().url().slice(0, 160) });
      await route.abort();
    });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await page.getByRole('heading', { name: 'Mecord Control Center' }).waitFor({ timeout: 5000 });
      assert.equal(await page.locator('input[type=password]').count(), 2);
      assert.equal(await page.locator('[role=tab]').count(), tabs.length);

      const layout = await page.evaluate(() => {
        const tablist = document.querySelector('[role=tablist]');
        const outer = tablist.getBoundingClientRect();
        const bounds = [...tablist.querySelectorAll('[role=tab]')].map(t => {
          const r = t.getBoundingClientRect();
          return { name: t.textContent, left: r.left, right: r.right };
        });
        return { viewport: innerWidth, docWidth: document.documentElement.scrollWidth,
          tabViewport: Math.round(outer.width),
          tabScrollWidth: tablist.scrollWidth,
          tabOverflowX: getComputedStyle(tablist).overflowX,
          unreachableTabs: bounds.filter(r => r.right > outer.right + 2 || r.left < outer.left - 2).map(r => r.name) };
      });
      if (layout.docWidth > viewport.width + 2) {
        failures.push({ viewport: viewport.name, type: 'horizontal-page-overflow', ...layout });
      }
      if (layout.unreachableTabs.length > 0 && layout.tabOverflowX === 'visible') {
        failures.push({ viewport: viewport.name, type: 'clipped-non-scrollable-tabs', ...layout });
      }
      results.push({ viewport: viewport.name, type: 'layout', ...layout });

      for (const id of tabs) {
        const selector = '[role=tab][data-tab="' + id + '"]';
        try {
          const tab = page.locator(selector);
          // Home is active on initial load. Assert its state here; a later
          // keyboard test clicks Home from another tab to prove actionability.
          // Avoid a redundant first click while Chrome stabilizes the new page.
          const initiallySelectedHome = id === 'tasks'
            && (await tab.getAttribute('aria-selected')) === 'true';
          if (!initiallySelectedHome) await tab.click({ timeout: 5000 });
          assert.equal(await tab.getAttribute('aria-selected'), 'true');
          assert.equal(await page.locator('#' + id).evaluate(el => getComputedStyle(el).display !== 'none'), true);
          await page.screenshot({ path: path.join(output, viewport.name + '-' + id + '.png'), fullPage: true });
          results.push({ viewport: viewport.name, type: 'tab', id, passed: true });
        } catch (err) {
          failures.push({ viewport: viewport.name, type: 'tab-interaction', id, message: String(err).slice(0, 500) });
          await page.screenshot({ path: path.join(output, viewport.name + '-' + id + '-failure.png'), fullPage: true });
        }
      }
      // Confirm actual WAI-ARIA tab keyboard operation, not just visible static DOM.
      try {
        await page.locator('[role="tab"][data-tab="tasks"]').click();
        const sequences = [['ArrowRight', 'approvals'], ['End', 'goals'],
          ['Home', 'tasks'], ['ArrowLeft', 'goals']];
        for (const [key, expected] of sequences) {
          await page.keyboard.press(key);
          const selected = page.locator('[role="tab"][aria-selected="true"]');
          assert.equal(await selected.count(), 1);
          assert.equal(await selected.getAttribute('data-tab'), expected);
          assert.equal(await selected.getAttribute('tabindex'), '0');
          assert.equal(await selected.evaluate(el => document.activeElement === el), true);
          const tabPanel = page.locator('#' + expected);
          assert.equal(await tabPanel.getAttribute('aria-labelledby'), 'tab-' + expected);
          assert.equal(await tabPanel.evaluate(el => getComputedStyle(el).display !== 'none'), true);
          results.push({ viewport: viewport.name, type: 'keyboard-navigation', key, expected, passed: true });
        }
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
        results.push({ viewport: viewport.name, type: 'keyboard-focus', element: focused });
        if (!focused || focused === 'BODY') throw new Error('Focus lost after keyboard navigation');
      } catch (error) {
        failures.push({ viewport: viewport.name, type: 'keyboard-navigation',
          message: String(error).slice(0, 500) });
      }
    } finally {
      await context.tracing.stop({ path: path.join(output, viewport.name + '-trace.zip') });
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const report = {
  hostname: actualHost, sourceCommit, timestamp: new Date().toISOString(),
  suite: ciSyntheticOnly
    ? 'HEADLESS CI synthetic Control Center UI; NOT GKKTT227 physical visual certification'
    : 'headed GKKTT227 synthetic Control Center UI; not live integration or hosted relay',
  browserExecutable: browserPath, outputDirectory: output,
  counts: { viewports: viewports.length, expectedTabChecks: tabs.length * viewports.length,
    passingTabChecks: results.filter(r => r.type === 'tab' && r.passed).length,
    failures: failures.length, consoleErrors: consoles.length },
  failures, consoleErrors: consoles, results
};
const reportFile = path.join(output, 'report.json');
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
process.stdout.write('MECORD_GKKTT227_VISUAL_AUDIT=' + JSON.stringify({
  sourceCommit, reportFile, ...report.counts
}) + '\n');
if (failures.length) {
  // Synthetic audit only: concise, bounded CI diagnostics reveal the exact
  // failing viewport/tab without requiring artifact ZIP download. The full
  // evidence report and screenshots remain authoritative.
  const diagnostics = failures.slice(0, 20).map(failure => ({
    viewport: failure.viewport, type: failure.type,
    ...(failure.id ? { id: failure.id } : {}),
    ...(failure.message ? { message: String(failure.message).slice(0, 300) } : {})
  }));
  process.stdout.write('MECORD_GKKTT227_VISUAL_FAILURES=' + JSON.stringify(diagnostics) + '\n');
}
if (failures.length || consoles.length) process.exitCode = 1;
