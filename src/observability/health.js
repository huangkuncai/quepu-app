export class HealthRegistry {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock;
    this.checks = new Map();
  }

  register(name, check, { critical = true } = {}) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new TypeError(`Invalid health check name: ${name}`);
    if (typeof check !== 'function') throw new TypeError('health check must be a function');
    this.checks.set(name, { check, critical });
    return this;
  }

  async readiness() {
    const results = {};
    let criticalFailure = false;
    for (const [name, definition] of this.checks) {
      const started = Date.now();
      try {
        const detail = await definition.check();
        results[name] = { status: 'ok', critical: definition.critical, durationMs: Date.now() - started, detail: detail ?? null };
      } catch (error) {
        results[name] = { status: 'failed', critical: definition.critical, durationMs: Date.now() - started, error: error.message };
        if (definition.critical) criticalFailure = true;
      }
    }
    return Object.freeze({ status: criticalFailure ? 'not_ready' : 'ready', checkedAt: this.clock(), checks: results });
  }

  liveness() {
    return Object.freeze({ status: 'ok', checkedAt: this.clock() });
  }
}

