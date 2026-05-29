/* Fixed-window in-memory rate limiter for auth routes. Per-instance only;
 * a multi-node deployment would need a shared store (Redis). Acceptable
 * for the current single-node control plane (documented caveat). */
export interface RateLimitOpts {
  windowMs: number;
  max: number;
}

/** Returns a `check(key, nowMs)` predicate: true = allowed, false = over
 *  limit. `nowMs` is injected so the logic is pure and testable. */
export function createRateLimiter(
  opts: RateLimitOpts,
): (key: string, nowMs: number) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key, nowMs) => {
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + opts.windowMs });
      return true;
    }
    if (entry.count >= opts.max) return false;
    entry.count += 1;
    return true;
  };
}
