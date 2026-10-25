import assert from 'node:assert/strict';
import test from 'node:test';
import type { CdpConnection, JsonMap } from '../src/capabilities/browser-cdp-connection.ts';
import { collectDiagnostics } from '../src/capabilities/browser-cdp-page.ts';

type Handler = (params: JsonMap) => void;
function fixture() {
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const session = {
    async send(name: string) { commands.push(name); return {}; },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => { handlers.delete(name); };
    }
  } as unknown as CdpConnection;
  return {
    session, commands, handlers,
    emit(name: string, params: JsonMap) {
      const handler = handlers.get(name);
      if (!handler) throw new Error('Unregistered synthetic CDP listener');
      handler(params);
    }
  };
}

test('C03 CDP diagnostic snapshots retain failure classes but never raw secret-bearing URLs or page logs', async () => {
  const harness = fixture();
  const diagnostics = await collectDiagnostics(harness.session);
  const secret = 'BEARER_PASSWORD_PRIVATE_SESSION_123';
  harness.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'https://private.test/?token=' + secret } });
  harness.emit('Log.entryAdded', { entry: { level: 'error', text: 'SECRET:' + secret } });
  harness.emit('Network.loadingFailed', {
    url: 'https://private.test:password@private.test/document/' + secret + '?code=' + secret,
    errorText: 'net::ERR_CONNECTION_RESET', blockedReason: 'csp'
  });
  harness.emit('Network.loadingFailed', {
    url: 'https://private.test/?api_key=' + secret,
    errorText: 'could not reach bearer:' + secret,
    blockedReason: 'secret-' + secret
  });
  const state = diagnostics.snapshot();
  assert.deepEqual(state.consoleErrors, [
    'RUNTIME_EXCEPTION_DETAILS_REDACTED',
    'BROWSER_LOG_ERROR_DETAILS_REDACTED'
  ]);
  assert.deepEqual(state.networkFailures, [
    { url: 'URL_REDACTED', errorText: 'net::ERR_CONNECTION_RESET', blockedReason: 'csp' },
    { url: 'URL_REDACTED', errorText: 'NETWORK_ERROR_DETAILS_REDACTED', blockedReason: 'BLOCKED_REASON_REDACTED' }
  ]);
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.deepEqual(harness.commands, ['Runtime.enable', 'Network.enable', 'Log.enable']);
  diagnostics.stop();
  assert.equal(harness.handlers.size, 0);
});

test('C03 hostile CDP error storms are bounded to 50 redacted entries', async () => {
  const harness = fixture();
  const diagnostics = await collectDiagnostics(harness.session);
  for (let i = 0; i < 80; i++) {
    harness.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'SECRET_' + i } });
    harness.emit('Network.loadingFailed', { url: 'https://secret.test/' + i, errorText: 'X-' + i });
  }
  const state = diagnostics.snapshot();
  assert.equal(state.consoleErrors.length, 50);
  assert.equal(state.networkFailures.length, 50);
  assert.ok(!JSON.stringify(state).includes('https://secret.test/'));
  assert.ok(state.consoleErrors.every(s => s.endsWith('_REDACTED')));
  diagnostics.stop();
});
