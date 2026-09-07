const LEVELS = Object.freeze({ silent: 0, fatal: 10, error: 20, warn: 30, info: 40, debug: 50, trace: 60 });
const SENSITIVE_KEY = /(pass|secret|token|authorization|cookie|credential|otp|verificationcode|private(?:tiles|hand|roundstate|seed)|handsbyplayer|handtiles|remainingwall|tilewall)/i;

function redact(value, key, seen) {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, '', seen));
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name, seen)]));
}

function writeToSink(sink, level, line) {
  if (typeof sink === 'function') return sink(line, level);
  const method = sink?.[level] || sink?.log;
  if (typeof method === 'function') method.call(sink, line);
}

export function createLogger({ level = 'info', sink = console, now = () => new Date().toISOString(), bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function log(logLevel, event, fields = {}) {
    if ((LEVELS[logLevel] ?? 0) > threshold) return;
    const record = {
      time: now(),
      level: logLevel,
      event: String(event),
      ...bindings,
      ...fields
    };
    const safeRecord = redact(record, '', new WeakSet());
    writeToSink(sink, logLevel, JSON.stringify(safeRecord));
  }
  const logger = {
    fatal: (event, fields) => log('fatal', event, fields),
    error: (event, fields) => log('error', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    info: (event, fields) => log('info', event, fields),
    debug: (event, fields) => log('debug', event, fields),
    trace: (event, fields) => log('trace', event, fields),
    child: childBindings => createLogger({ level, sink, now, bindings: { ...bindings, ...childBindings } })
  };
  return Object.freeze(logger);
}

export { LEVELS, redact };
