const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function metricName(name) {
  if (!NAME.test(name)) throw new TypeError(`Invalid metric name: ${name}`);
  return name;
}

function labelSet(labels = {}) {
  return Object.keys(labels).sort().map(name => {
    if (!LABEL.test(name)) throw new TypeError(`Invalid metric label: ${name}`);
    const value = String(labels[name]).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    return `${name}="${value}"`;
  }).join(',');
}

export class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
  }

  increment(name, labels = {}, value = 1) {
    metricName(name);
    if (!Number.isFinite(value)) throw new TypeError('metric value must be finite');
    const key = `${name}|${labelSet(labels)}`;
    this.counters.set(key, { name, labels, value: (this.counters.get(key)?.value || 0) + value });
    return this.counters.get(key).value;
  }

  setGauge(name, value, labels = {}) {
    metricName(name);
    if (!Number.isFinite(value)) throw new TypeError('metric value must be finite');
    const key = `${name}|${labelSet(labels)}`;
    this.gauges.set(key, { name, labels, value });
    return value;
  }

  renderPrometheus() {
    const lines = [];
    for (const metric of [...this.counters.values(), ...this.gauges.values()]) {
      const labels = labelSet(metric.labels);
      lines.push(`${metric.name}${labels ? `{${labels}}` : ''} ${metric.value}`);
    }
    return `${lines.join('\n')}${lines.length ? '\n' : ''}`;
  }
}

