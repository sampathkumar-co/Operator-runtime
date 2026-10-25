import assert from 'node:assert/strict';
import test from 'node:test';
import { sameDestination, waitForDestinationReady } from '../src/capabilities/browser-cdp-page.ts';

test('browser destination proof must match explicitly requested SPA fragments and query', () => {
  assert.equal(
    sameDestination('https://example.com/search?q=operator#result', 'https://example.com/search?q=operator#top'),
    false
  );
  assert.equal(
    sameDestination('https://example.com/search?q=attacker', 'https://example.com/search?q=operator'),
    false
  );
});

test('browser destination proof still rejects origin and path changes', () => {
  assert.equal(sameDestination('https://evil.example/search?q=operator', 'https://example.com/search?q=operator'), false);
  assert.equal(sameDestination('https://example.com/other?q=operator', 'https://example.com/search?q=operator'), false);
  assert.equal(sameDestination('https://example.com/search/?q=operator', 'https://example.com/search?q=operator'), true);
});

test('destination-aware readiness ignores a complete transient about:blank document', async () => {
  const states = [
    { url: 'about:blank', title: '', readyState: 'complete' },
    { url: 'https://example.com/report?q=1', title: 'Report', readyState: 'loading' },
    { url: 'https://example.com/report?q=1#done', title: 'Report', readyState: 'complete' }
  ];
  const session = {
    async send() {
      const state = states.shift() ?? { url: 'https://example.com/report?q=1', title: 'Report', readyState: 'complete' };
      return { result: { value: state } };
    }
  } as any;
  const result = await waitForDestinationReady(session, 'https://example.com/report?q=1', 1_000);
  assert.equal(result.firstObservedUrl, 'about:blank');
  assert.equal(result.state.url, 'https://example.com/report?q=1#done');
  assert.equal(result.polls, 3);
});

test('destination-aware readiness is abortable while the destination is wrong', async () => {
  const controller = new AbortController();
  const session = { async send() { controller.abort(); return { result: { value: { url: 'about:blank', title: '', readyState: 'complete' } } }; } } as any;
  await assert.rejects(waitForDestinationReady(session, 'https://example.com/', 1_000, controller.signal), (error: any) => error.code === 'EXECUTION_ABORTED');
});

test('C03 hash-routed destination cannot be falsely verified from an adjacent SPA view', () => {
  assert.equal(sameDestination('https://example.com/app#/inbox', 'https://example.com/app#/billing'), false);
  assert.equal(sameDestination('https://example.com/app#/billing', 'https://example.com/app#/billing'), true);
  assert.equal(sameDestination('https://example.com/app', 'https://example.com/app#/billing'), false);
  // A document-level navigation with no explicit fragment still admits
  // an ordinary in-document anchor, preserving legacy non-hash routing.
  assert.equal(sameDestination('https://example.com/report#section', 'https://example.com/report'), true);
});

test('C03 navigation readiness waits for the requested hash route, not just document complete', async () => {
  const states=[
    {url:'https://example.com/app#/inbox',title:'App',readyState:'complete'},
    {url:'https://example.com/app#/billing',title:'Billing',readyState:'complete'}
  ];
  const session={async send(){return {result:{value:states.shift() ?? {url:'https://example.com/app#/billing',title:'Billing',readyState:'complete'}}};}} as any;
  const outcome=await waitForDestinationReady(session,'https://example.com/app#/billing',1000);
  assert.equal(outcome.polls,2);
  assert.equal(outcome.state.url,'https://example.com/app#/billing');
});
