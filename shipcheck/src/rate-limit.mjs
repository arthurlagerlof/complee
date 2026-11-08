export function createRateLimiter({ windowMs = 60_000, maxRequests = 120, now = Date.now, maxKeys = 10_000 } = {}) {
  const entries = new Map();
  let calls = 0;

  return {
    check(key) {
      const time = now();
      let entry = entries.get(key);
      if (entry && time - entry.startedAt >= windowMs) {
        entries.delete(key);
        entry = null;
      }
      if (!entry) {
        if (entries.size >= maxKeys) {
          for (const [candidate, value] of entries) {
            if (time - value.startedAt >= windowMs) entries.delete(candidate);
          }
          if (entries.size >= maxKeys) {
            return { allowed: false, retryAfter: Math.ceil(windowMs / 1000) };
          }
        }
        entry = { startedAt: time, count: 0 };
        entries.set(key, entry);
      }
      entry.count += 1;

      if (++calls % 256 === 0) {
        for (const [candidate, value] of entries) {
          if (time - value.startedAt >= windowMs) entries.delete(candidate);
        }
      }
      return entry.count <= maxRequests
        ? { allowed: true, retryAfter: 0 }
        : { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.startedAt + windowMs - time) / 1000)) };
    },
  };
}
