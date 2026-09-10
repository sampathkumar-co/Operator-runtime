import assert from 'node:assert/strict';
import test from 'node:test';
import { sameDestination } from '../src/capabilities/browser-cdp-page.ts';

test('browser destination proof includes the query string while ignoring fragments', () => {
  assert.equal(
    sameDestination('https://example.com/search?q=operator#result', 'https://example.com/search?q=operator#top'),
    true
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
