/**
 * Check a Redis-compatible client without coupling the application to a
 * particular Redis package. The client only needs an async `ping()` method.
 */
export async function checkRedisHealth(client, { timeoutMs = 1000 } = {}) {
  if (!client || typeof client.ping !== 'function') {
    return Object.freeze({ status: 'unconfigured', backend: 'redis', reason: 'PING_UNAVAILABLE' });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => client.ping()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs);
      })
    ]);
    return Object.freeze({
      status: String(result).toUpperCase() === 'PONG' ? 'ok' : 'degraded',
      backend: 'redis',
      response: String(result)
    });
  } catch (error) {
    return Object.freeze({
      status: 'unavailable',
      backend: 'redis',
      reason: error instanceof Error ? error.message : String(error)
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
