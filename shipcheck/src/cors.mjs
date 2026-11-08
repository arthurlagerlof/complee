// CORS for the ShipCheck server. Allowed origins come from ALLOWED_ORIGINS (comma-separated, exact origins such
// as https://complee.example.com; "*" allows any origin). Default: localhost / 127.0.0.1 / [::1] on any port.
// Node only (no I/O); used by server.mjs.

const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function parseAllowedOrigins(value = '') {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    if (item === '*') throw new Error('ALLOWED_ORIGINS must list exact website origins; wildcard access is not allowed.');
    const normalized = item.replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(normalized); } catch { throw new Error(`Invalid ALLOWED_ORIGINS entry: ${item}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== normalized || parsed.username || parsed.password) {
      throw new Error(`ALLOWED_ORIGINS entries must be exact HTTP(S) origins without paths: ${item}`);
    }
    return normalized;
  });
}

export function isAllowedOrigin(origin, allowed = []) {
  if (!origin) return false;
  if (!allowed.length) return LOCALHOST.test(origin);
  return allowed.includes(origin.replace(/\/+$/, ''));
}

// Returns the headers to add for this request, or null when the origin is not allowed (or absent).
export function corsHeaders(origin, allowed = []) {
  if (!isAllowedOrigin(origin, allowed)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
