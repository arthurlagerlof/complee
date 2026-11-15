// Who may use what on the ShipCheck server. Node only (no I/O); used by server.mjs.
//
// "This computer only" features (AI, rule verification, Revit conversion, the APS token) used to trust the socket
// address alone. That is not enough:
//  - every web page open in the engineer's browser also connects from 127.0.0.1, and a cross-site "simple" POST
//    (text/plain, no preflight) reaches the server even though CORS hides the answer;
//  - a page on an attacker's domain can point that domain at 127.0.0.1 (DNS rebinding) and then read answers;
//  - a reverse proxy on the same host makes every internet request look local.
// So a request counts as local only when it comes from loopback, names a loopback host, carries no proxy header, and
// is not sent by another site. Every request that changes something must come from an allowed origin (or carry no
// Origin at all, as curl and scripts do), and JSON bodies must say so (application/json always needs a preflight).
import { isAllowedOrigin } from './cors.mjs';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'x-forwarded-host'];

export const isLoopbackSocket = (req) => LOOPBACK_ADDRESSES.has(req?.socket?.remoteAddress);
export const isLoopbackHost = (host) => LOOPBACK_HOST.test(String(host || ''));

// Same origin as the request itself (scheme ignored: the server does not know it behind a proxy), or listed.
export function originAllowed(req, allowed = []) {
  const origin = req.headers?.origin;
  const site = String(req.headers?.['sec-fetch-site'] || '');
  if (!origin || origin === 'null') {
    // No Origin: a script or a same-origin navigation. A browser that says "cross-site" is refused anyway.
    return origin !== 'null' && site !== 'cross-site';
  }
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host && host.toLowerCase() === String(req.headers?.host || '').toLowerCase()) return true;
  return isAllowedOrigin(origin, allowed);
}

// A request from this computer, by this computer's own pages.
export function isLocalRequest(req, allowed = []) {
  if (!isLoopbackSocket(req)) return false;
  if (!isLoopbackHost(req.headers?.host)) return false;
  if (PROXY_HEADERS.some((h) => req.headers?.[h] != null)) return false;
  const origin = req.headers?.origin;
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    if (!isLoopbackHost(host)) return false;
  }
  return originAllowed(req, allowed);
}

export function contentTypeIs(req, type) {
  return String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() === type;
}

// Client address for rate limiting. Forwarding headers are believed only when a proxy is declared
// (TRUST_PROXY=true: X-Real-IP set by the shipped Caddy config; TRUST_CLOUDFLARE_TUNNEL=true: CF-Connecting-IP),
// otherwise any client could choose its own address and both escape and exhaust the limiter.
export function clientAddress(req, { trustProxy = false, trustCloudflare = false, isIP = () => true } = {}) {
  const pick = trustCloudflare ? String(req.headers?.['cf-connecting-ip'] || '').trim()
    : trustProxy ? String(req.headers?.['x-real-ip'] || '').trim() : '';
  const forwarded = pick.startsWith('::ffff:') ? pick.slice(7) : pick;
  if (forwarded && isIP(forwarded)) return forwarded;
  const remote = String(req.socket?.remoteAddress || 'unknown');
  return remote.startsWith('::ffff:') ? remote.slice(7) : remote;
}

// Path below /api/rule-verification/ that may be forwarded: plain segments only. Encoded characters (%2e%2e, %2f)
// would be decoded again by the upstream request and could climb out of the verification API.
export function safeForwardPath(rest) {
  const segments = String(rest).split('/');
  return segments.length > 0 && segments.every((s) => /^[\w\-.@]+$/.test(s) && s !== '.' && s !== '..');
}
