import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedWindowRateLimiter, envRateLimit, principalRateKey } from '../src/rate-limit.ts';

test('fixed-window limiter blocks over quota and resets after the window', () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
  assert.equal(limiter.hit('ip:1').allowed, true);
  assert.equal(limiter.hit('ip:1').allowed, true);
  const blocked = limiter.hit('ip:1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  now = 2_001;
  assert.equal(limiter.hit('ip:1').allowed, true);
});

test('auth-failure limiter can be inspected and cleared without consuming quota', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 10_000 });
  assert.equal(limiter.isLimited('ip:2').allowed, true);
  limiter.hit('ip:2');
  assert.equal(limiter.isLimited('ip:2').allowed, true);
  limiter.hit('ip:2');
  assert.equal(limiter.isLimited('ip:2').allowed, false);
  limiter.clear('ip:2');
  assert.equal(limiter.isLimited('ip:2').allowed, true);
});

test('principal keys are opaque and env limits are bounded', () => {
  const key = principalRateKey('https://issuer.example', 'user-123');
  assert.match(key, /^principal:[A-Za-z0-9_-]+$/);
  assert.equal(key.includes('user-123'), false);
  assert.equal(envRateLimit(undefined, 300, 'TEST_LIMIT'), 300);
  assert.equal(envRateLimit('12', 300, 'TEST_LIMIT'), 12);
  assert.throws(() => envRateLimit('0', 300, 'TEST_LIMIT'), /between 1 and 100000/);
});
