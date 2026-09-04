import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createObservabilityServer } from '../src/observability/http.js';
import { HealthRegistry } from '../src/observability/health.js';
import { MetricsRegistry } from '../src/observability/metrics.js';

test('observability control server exposes health, readiness and metrics endpoints', async () => {
  const health = new HealthRegistry({ clock: () => '2026-08-28T00:00:00.000Z' });
  health.register('database', () => ({ backend: 'memory' }));
  const metrics = new MetricsRegistry();
  metrics.increment('test_requests_total');
  const control = createObservabilityServer({ health, metrics, port: 0 });
  await once(control.server, 'listening');
  const port = control.server.address().port;
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).status, 'ok');
    const readyResponse = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(readyResponse.status, 200);
    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(await metricsResponse.text(), /test_requests_total 1/);
    const missingResponse = await fetch(`http://127.0.0.1:${port}/missing`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await control.close();
  }
});

