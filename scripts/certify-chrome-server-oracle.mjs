// Opt-in actual Windows Chrome provider campaign with an independent localhost server oracle.
// No model, live account, protected receipt, external website or original Chrome profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { BrowserCdpProvider } from '../src/capabilities/browser-cdp.ts';

export function validServerReceipts(expected, records) {
  if (!Array.isArray(expected) || expected.length !== 5 ||
      !Array.isArray(records) || records.length !== 5) return false;
  const ids = new Set();
  return records.every((record, index) => {
    const e = expected[index];
    if (!record || typeof record !== 'object' || ids.has(record.id)) return false;
    ids.add(record.id);
    return record.id === e.id && record.value === e.value &&
      record.receipt === e.receipt && record.accepted === true;
  });
}

export async function certifyPhysicalChromeOracle({
  platform = process.platform, env = process.env,
  chromePath = env.MECORD_TEST_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
} = {}) {
  if (platform !== 'win32' || env.MECORD_PHYSICAL_ACCEPTANCE !== '1')
    throw new Error('PHYSICAL_CHROME_ORACLE_NOT_AUTHORIZED');
  if (!path.win32.isAbsolute(chromePath) ||
      !(await fs.stat(chromePath).catch(() => null))?.isFile())
    throw new Error('PHYSICAL_CHROME_ORACLE_NO_CHROME');

  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'],
    { encoding: 'utf8' }).trim();
  assert.match(sourceCommit, /^[0-9a-f]{40}$/);
  const nonce = crypto.randomBytes(12).toString('hex');
  const expected = Array.from({ length: 5 }, (_, i) => ({
    id: 'id-' + i + '-' + nonce, value: 'value-' + i + '-' + nonce,
    receipt: 'receipt-' + i + '-' + nonce
  }));
  const map = new Map(expected.map(item => [item.id, item]));
  const records = [];
  let rejected = 0;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-physical-chrome-oracle-'));
  const page = [
    '<!doctype html><html><head><title>Isolated Receipt Oracle</title></head>',
    '<body><h1>Disposable Chrome test</h1>',
    '<label>Task value <input id="value" aria-label="Task value"></label>',
    '<button id="submit">Submit</button><output id="receipt">NOT_SUBMITTED</output>',
    '<script>',
    'document.getElementById("submit").addEventListener("click", async () => {',
    'const id = new URL(location.href).searchParams.get("id");',
    'const value = document.getElementById("value").value;',
    'const r = await fetch("/submit", {method:"POST", headers:{"content-type":"application/json"},',
    'body:JSON.stringify({id,value})}); const body=await r.json();',
    'document.getElementById("receipt").textContent = r.ok ? body.receipt : "REJECTED";',
    '});',
    '</script></body></html>'
  ].join('');
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url?.startsWith('/?id=')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(page);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/submit') {
      rejected++;
      res.writeHead(404).end('{}');
      return;
    }
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString('utf8');
        if (Buffer.byteLength(raw, 'utf8') > 4096) throw Error('too big');
      }
      const input = JSON.parse(raw);
      const item = map.get(input.id);
      if (!item || input.value !== item.value ||
          records.some(record => record.id === input.id)) {
        rejected++;
        res.writeHead(409).end(JSON.stringify({ error: 'rejected' }));
        return;
      }
      const result = { id: item.id, value: item.value,
        receipt: item.receipt, accepted: true };
      records.push(result);
      res.writeHead(200).end(JSON.stringify({ receipt: item.receipt }));
    } catch {
      rejected++;
      res.writeHead(400).end(JSON.stringify({ error: 'malformed' }));
    }
  });
  let chrome;
  let provider;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    chrome = spawn(chromePath, [
      '--headless=new','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--disable-extensions',
      '--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'
    ], { windowsHide: true, stdio: 'ignore' });
    let cdpPort;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (chrome.exitCode !== null) throw Error('isolated Chrome exited');
      try {
        const active = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8');
        const port = Number(active.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          cdpPort = port; break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(cdpPort, 'No isolated CDP endpoint');
    provider = new BrowserCdpProvider('http://127.0.0.1:' + cdpPort);
    let actionIndex = 0;
    const action = async (capability, risk, input) => {
      const result = await provider.execute({
        id: 'physical-oracle-' + (++actionIndex), capability, risk, input,
        provenance: { kind: 'runtime', source: 'isolated-five-case-server-oracle' }
      });
      assert.equal(result.ok, true, capability + ':' + result.error?.code);
      return result;
    };
    const durations = [];
    for (const item of expected) {
      const start = performance.now();
      const opened = await action('browser.navigate', 'external', {
        url: origin + '/?id=' + encodeURIComponent(item.id), newTab: true
      });
      const targetId = opened.output.targetId;
      assert.equal(typeof targetId, 'string');
      const before = await action('browser.verify', 'read',
        { targetId, expect: { textContains: item.receipt } });
      assert.equal(before.output.status, 'NOT_COMPLETE', 'unsubmitted task already verified');
      await action('browser.interact', 'external', {
        targetId, operation: 'type', target: { css: '#value' }, value: item.value
      });
      const typed = await action('browser.verify', 'read', {
        targetId, target: { css: '#value' }, expect: { value: item.value }
      });
      assert.equal(typed.output.status, 'VERIFIED');
      await action('browser.interact', 'external', {
        targetId, operation: 'click', target: { css: '#submit' }
      });
      let observed = false;
      const timeout = Date.now() + 4_000;
      while (Date.now() < timeout) {
        const proof = await action('browser.verify', 'read',
          { targetId, expect: { textContains: item.receipt } });
        if (proof.output.status === 'VERIFIED') { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(observed, 'server acknowledgement not independently observed in DOM');
      assert.deepEqual(records.find(r => r.id === item.id), {
        id: item.id, value: item.value, receipt: item.receipt, accepted: true
      }, 'server-side postcondition missing');
      durations.push(performance.now() - start);
    }
    assert.ok(validServerReceipts(expected, records), 'independent oracle mismatch');
    assert.equal(rejected, 0);
    const sorted = durations.sort((a,b) => a-b);
    return {
      schemaVersion: 1, sourceCommit, platform, node: process.version,
      suite: 'FIVE_FIXED_REAL_CHROME_PROVIDER_TASKS_WITH_INDEPENDENT_LOCAL_SERVER',
      tasks: 5, independentlyVerified: 5, serverAccepted: records.length,
      serverRejected: rejected, p50Ms: +sorted[2].toFixed(1),
      p95Ms: +sorted[4].toFixed(1),
      browserProfile: 'ISOLATED_DISPOSABLE', originalState: 'NOT_TOUCHED',
      modelScoring: 'NOT_RUN', officialMiniWob: 'NOT_RUN',
      heldOut50: 'NOT_RUN', hostRecovery: 'NOT_RUN', release: 'NOT_ACCEPTED'
    };
  } finally {
    provider?.close();
    if (chrome?.pid && chrome.exitCode === null) {
      try {
        execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'],
          { timeout: 7000, windowsHide: true, stdio: 'ignore' });
      } catch { chrome.kill(); }
    }
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.rm(profile, { recursive: true, force: true,
      maxRetries: 5, retryDelay: 150 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await certifyPhysicalChromeOracle();
  process.stdout.write('MECORD_PHYSICAL_CHROME_ORACLE=' + JSON.stringify(result) + '\n');
}
