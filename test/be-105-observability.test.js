import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/observability/logger.js';
import { HealthRegistry } from '../src/observability/health.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { FixedWindowRateLimiter } from '../src/security/rate-limit.js';
import { isAllowedOrigin, parseAllowedOrigins } from '../src/security/origin.js';

test('structured logger redacts tokens, credentials and private tile fields', () => {
  const lines = [];
  const logger = createLogger({ sink: line => lines.push(line), now: () => '2026-08-28T00:00:00.000Z' });
  logger.info('command.received', {
    requestId: 'req-1',
    accessToken: 'secret-token',
    verificationCode: '000000',
    privateTiles: ['wan-1'],
    privateRoundState: { remainingWall: ['characters-1-1'] },
    handsByPlayer: { p1: ['characters-1-2'] },
    errorCode: 'AUTH_REQUIRED'
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.requestId, 'req-1');
  assert.equal(record.accessToken, '[REDACTED]');
  assert.equal(record.verificationCode, '[REDACTED]');
  assert.equal(record.privateTiles, '[REDACTED]');
  assert.equal(record.privateRoundState, '[REDACTED]');
  assert.equal(record.handsByPlayer, '[REDACTED]');
  assert.equal(record.errorCode, 'AUTH_REQUIRED');
});

test('fixed-window limiter reports remaining quota and retry timing', () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 100, clock: () => now });
  assert.equal(limiter.consume('user-1').allowed, true);
  assert.equal(limiter.consume('user-1').remaining, 0);
  const blocked = limiter.consume('user-1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 100);
  now += 100;
  assert.equal(limiter.consume('user-1').allowed, true);
});

test('health registry distinguishes critical and non-critical checks', async () => {
  const health = new HealthRegistry({ clock: () => 'now' });
  health.register('postgres', async () => ({ version: 'test' }));
  health.register('optional_push', () => { throw new Error('not configured'); }, { critical: false });
  let result = await health.readiness();
  assert.equal(result.status, 'ready');
  health.register('redis', () => { throw new Error('down'); });
  result = await health.readiness();
  assert.equal(result.status, 'not_ready');
  assert.equal(health.liveness().status, 'ok');
});

test('metrics render escaped Prometheus labels', () => {
  const metrics = new MetricsRegistry();
  metrics.increment('ws_commands_total', { type: 'action', result: 'ok' });
  metrics.setGauge('ws_connections', 2);
  const output = metrics.renderPrometheus();
  assert.match(output, /ws_commands_total\{result="ok",type="action"\} 1/);
  assert.match(output, /ws_connections 2/);
});

test('origin policy permits native handshakes and exact configured browser origins', () => {
  const allowed = parseAllowedOrigins('https://app.example, https://admin.example');
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin('https://app.example', allowed), true);
  assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
  assert.equal(isAllowedOrigin(undefined, allowed, { allowMissing: false }), false);
});
