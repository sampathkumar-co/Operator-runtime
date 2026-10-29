import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../apps/local-agent/src/runtime-factory.ts';
import { parseApprovalConsoleCommand } from '../packages/mecord-connect/src/approval-console.mjs';
import { createLocalAgentServer } from '../apps/local-agent/src/server.ts';
import {
  ControlCenterSessions,
  browserUiRouteAllowed,
  controlCenterBrowserRequestAllowed
} from '../apps/local-agent/src/control-center-session.ts';

test('trusted terminal exposes a browser login command instead of agent-token extraction', () => {
  assert.deepEqual(parseApprovalConsoleCommand('control-center'), { kind: 'control-center' });
  assert.deepEqual(parseApprovalConsoleCommand('control-center anything'), { kind: 'invalid' });
});

test('browser codes are one-time, expire, limit guesses and never equal bearer credentials', () => {
  const sessions = new ControlCenterSessions();
  const first = sessions.issueCode(10_000);
  assert.match(first.code, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(sessions.redeemCode(first.code, 100_000), null, 'expired code');
  const fresh = sessions.issueCode(110_000);
  for (let i = 0; i < 5; i++) assert.equal(sessions.redeemCode('a'.repeat(16), 110_001), null);
  assert.equal(sessions.redeemCode(fresh.code, 110_001), null, 'locked after five guesses');
  const issued = sessions.issueCode(120_000);
  const cookie = sessions.redeemCode(issued.code, 120_001);
  assert.ok(cookie);
  assert.notEqual(cookie, issued.code);
  assert.equal(sessions.redeemCode(issued.code, 120_002), null, 'cannot replay one-time code');
  assert.ok(sessions.validCookie(sessions.cookie(cookie).split(';')[0], 120_003));
  assert.equal(sessions.validCookie(sessions.cookie(cookie).split(';')[0], 120_001 + 4 * 60 * 60_000), null, 'absolute expiry');
});

test('browser authority only accepts exact local host, same-origin mutations and declared UI routes', () => {
  const safe = { host: '127.0.0.1:43820', origin: 'http://127.0.0.1:43820', 'x-mecord-control-center': '1' };
  assert.equal(controlCenterBrowserRequestAllowed(safe, 43820, true), true);
  assert.equal(controlCenterBrowserRequestAllowed({ ...safe, host: 'evil.com' }, 43820, true), false);
  assert.equal(controlCenterBrowserRequestAllowed({ ...safe, origin: 'http://evil.com' }, 43820, true), false);
  assert.equal(controlCenterBrowserRequestAllowed({ ...safe, 'x-mecord-control-center': undefined }, 43820, true), false);
  assert.equal(controlCenterBrowserRequestAllowed({ ...safe, 'sec-fetch-site': 'cross-site' }, 43820, false), false);
  assert.equal(browserUiRouteAllowed('GET', '/v1/control-center/approvals'), true);
  assert.equal(browserUiRouteAllowed('GET', '/v1/control-center/original-recovery/browser'), true);
  assert.equal(browserUiRouteAllowed('GET', '/v1/control-center/original-recovery'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/control-center/original-recovery/browser'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/control-center/original-recovery/browser/resolve'), true);
  assert.equal(browserUiRouteAllowed('POST', '/v1/control-center/original-recovery/browser/delete'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/approvals/abc'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/session-approval'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/tasks/abc/run'), true);
  assert.equal(browserUiRouteAllowed('DELETE', '/v1/tasks/abc'), false);
  assert.equal(browserUiRouteAllowed('POST', '/v1/device-reset'), false);
});

test('local browser login is secure, functional and cannot grant recovery authority', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mecord-cc-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({ allowedRoots: [root], allowedExecutables: ['node'] });
  const token = 'g'.repeat(64);
  const recoveryToken = 's'.repeat(64);
  const agent = createLocalAgentServer({
    runtime, token, recoveryToken,
    permissions: { allowedCapabilities: ['computer.inspect'], allowedRoots: [root] }
  });
  t.after(() => Promise.allSettled([agent.close(), runtime.close()]));
  const bound = await agent.listen('127.0.0.1', 0);
  const base = `http://127.0.0.1:${bound.port}`;
  const uiHeaders = { origin: base, 'x-mecord-control-center': '1', 'content-type': 'application/json' };

  const shell = await fetch(base + '/control-center');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /One-time local login code/);

  const unauth = await fetch(base + '/v1/control-center/approvals');
  assert.equal(unauth.status, 401);

  const deniedIssue = await fetch(base + '/v1/control-center/browser-login/code', { method: 'POST' });
  assert.equal(deniedIssue.status, 401);
  const issued = await fetch(base + '/v1/control-center/browser-login/code', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json() as { code: string };
  assert.ok(code);
  assert.notEqual(code, token);
  assert.notEqual(code, recoveryToken);

  const wrongOrigin = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST', headers: { ...uiHeaders, origin: 'https://attacker.example' }, body: JSON.stringify({ code })
  });
  assert.equal(wrongOrigin.status, 403);

  const signedIn = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST', headers: uiHeaders, body: JSON.stringify({ code })
  });
  assert.equal(signedIn.status, 200);
  const signedInPayload = JSON.stringify(await signedIn.json());
  assert.equal(signedInPayload.includes(token), false);
  assert.equal(signedInPayload.includes(recoveryToken), false);
  assert.equal(signedInPayload.includes(code), false);
  const cookie = signedIn.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes(token), false);
  const sessionCookie = cookie.split(';')[0];

  const read = await fetch(base + '/v1/control-center/approvals', {
    headers: { cookie: sessionCookie }
  });
  assert.equal(read.status, 200);
  const denial = await fetch(base + '/v1/approvals/abc', {
    method: 'POST', headers: { ...uiHeaders, cookie: sessionCookie }, body: '{}'
  });
  assert.equal(denial.status, 401, 'browser session is never recovery authority');
  const crossSite = await fetch(base + '/v1/control-center/approvals', {
    headers: { cookie: sessionCookie, origin: 'https://attacker.example' }
  });
  assert.equal(crossSite.status, 401);
  const replay = await fetch(base + '/v1/control-center/browser-login', {
    method: 'POST', headers: uiHeaders, body: JSON.stringify({ code })
  });
  assert.equal(replay.status, 401);

  const logout = await fetch(base + '/v1/control-center/browser-logout', {
    method: 'POST', headers: { ...uiHeaders, cookie: sessionCookie }, body: '{}'
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(base + '/v1/control-center/approvals', { headers: { cookie: sessionCookie } });
  assert.equal(afterLogout.status, 401);
});
