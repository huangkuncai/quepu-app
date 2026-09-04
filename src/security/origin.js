export function parseAllowedOrigins(value = '') {
  return Object.freeze(new Set(String(value).split(',').map(origin => origin.trim()).filter(Boolean)));
}

/** Missing Origin is allowed for native clients; configured browser origins must match exactly. */
export function isAllowedOrigin(origin, allowedOrigins, { allowMissing = true } = {}) {
  if (!origin) return allowMissing;
  if (!allowedOrigins || allowedOrigins.size === 0) return false;
  return allowedOrigins.has(origin);
}

