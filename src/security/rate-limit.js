import { AppError } from '../shared/errors.js';

/** Small fixed-window limiter for a single process; replace with Redis at scale. */
export class FixedWindowRateLimiter {
  constructor({ limit = 60, windowMs = 60_000, clock = () => Date.now() } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs must be a positive integer');
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.buckets = new Map();
  }

  consume(key, cost = 1) {
    if (!key) throw new AppError('INVALID_MESSAGE', { message: 'A rate-limit key is required' });
    if (!Number.isInteger(cost) || cost < 1) throw new TypeError('cost must be a positive integer');
    const now = this.clock();
    const current = this.buckets.get(String(key));
    if (!current || current.resetAt <= now) {
      const bucket = { count: cost, resetAt: now + this.windowMs };
      this.buckets.set(String(key), bucket);
      return Object.freeze({ allowed: cost <= this.limit, remaining: Math.max(0, this.limit - cost), retryAfterMs: 0 });
    }
    current.count += cost;
    const allowed = current.count <= this.limit;
    return Object.freeze({
      allowed,
      remaining: Math.max(0, this.limit - current.count),
      retryAfterMs: allowed ? 0 : Math.max(0, current.resetAt - now)
    });
  }

  assertAllowed(key, cost = 1) {
    const result = this.consume(key, cost);
    if (!result.allowed) throw new AppError('RATE_LIMITED', { details: { retryAfterMs: result.retryAfterMs } });
    return result;
  }

  clear(key) {
    return this.buckets.delete(String(key));
  }

  size() {
    return this.buckets.size;
  }
}

