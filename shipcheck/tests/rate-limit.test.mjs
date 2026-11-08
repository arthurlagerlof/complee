import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rate-limit.mjs';

test('rate limiter enforces a per-key window and resets after expiry', () => {
  let time = 1_000;
  const limiter = createRateLimiter({ windowMs: 10_000, maxRequests: 2, now: () => time });
  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfter: 0 });
  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfter: 0 });
  assert.deepEqual(limiter.check('client-a'), { allowed: false, retryAfter: 10 });
  assert.deepEqual(limiter.check('client-b'), { allowed: true, retryAfter: 0 });
  time += 10_000;
  assert.deepEqual(limiter.check('client-a'), { allowed: true, retryAfter: 0 });
});

test('rate limiter bounds tracked clients', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, now: () => 1_000, maxKeys: 1 });
  assert.equal(limiter.check('client-a').allowed, true);
  assert.equal(limiter.check('client-b').allowed, false);
});

test('public API endpoints enforce the configured per-IP limit without login', async (t) => {
  process.env.ALLOWED_ORIGINS = 'https://demo.example';
  const log = console.log;
  console.log = () => {};
  const { server } = await import('../server.mjs');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log = log;
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  let last;
  for (let i = 0; i < 121; i++) last = await fetch(url);
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});
