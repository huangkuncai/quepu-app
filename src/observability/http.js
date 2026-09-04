import { createServer } from 'node:http';

function sendJson(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content)
  });
  response.end(content);
}

/**
 * Bind health/readiness/metrics to a private control port. The caller decides
 * whether and where this port is exposed; it is never mixed with public WSS.
 */
export function createObservabilityServer({ health, metrics, host = '127.0.0.1', port = 0 } = {}) {
  if (!health || typeof health.liveness !== 'function' || typeof health.readiness !== 'function') {
    throw new TypeError('health registry is required');
  }
  if (!metrics || typeof metrics.renderPrometheus !== 'function') throw new TypeError('metrics registry is required');
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (request.url === '/healthz') return sendJson(response, 200, health.liveness());
      if (request.url === '/readyz') {
        const result = await health.readiness();
        return sendJson(response, result.status === 'ready' ? 200 : 503, result);
      }
      if (request.url === '/metrics') {
        const content = metrics.renderPrometheus();
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(content);
      }
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch {
      return sendJson(response, 503, { error: 'HEALTH_CHECK_FAILED' });
    }
  });
  server.listen(port, host);
  return {
    server,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

