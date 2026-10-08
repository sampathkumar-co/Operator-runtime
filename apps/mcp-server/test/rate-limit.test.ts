import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
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


test('limiter capacity fails closed without evicting active quotas, and reclaims expired windows', () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 2, clock: () => now });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('b').allowed, true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.hit('c').allowed, false);
  assert.equal(limiter.isLimited('c').allowed, false);
  assert.equal(limiter.isLimited('a').allowed, false);
  assert.equal(limiter.isLimited('b').remaining, 1);
  assert.equal(limiter.size, 2);
  now += 60_001;
  assert.equal(limiter.hit('c').allowed, true);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.isLimited('a').remaining, 2);
});

test('unique-key saturation remains bounded-amortized at public-edge scale', () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 20_000 });
  const started = performance.now();
  for (let i = 0; i < 40_000; i += 1) limiter.hit(`attacker:${i}`);
  const elapsedMs = performance.now() - started;
  assert.equal(limiter.size, 20_000);
  assert.ok(elapsedMs < 1_000, `40k unique limiter hits took ${elapsedMs.toFixed(1)}ms`);
});
