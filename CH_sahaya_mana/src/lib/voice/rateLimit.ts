/**
 * Small in-memory sliding-window rate limiter, per session and bucket. Process-local (like the demo store);
 * it bounds abuse of the voice routes and token minting, it isn't a distributed quota.
 */
export interface RateRule {
  limit: number;
  windowMs: number;
}

export const VOICE_RATE_RULES: Record<string, RateRule> = {
  token: { limit: 12, windowMs: 60_000 },
  transcribe: { limit: 20, windowMs: 60_000 },
  speak: { limit: 60, windowMs: 60_000 },
  health: { limit: 30, windowMs: 60_000 },
};

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly rules: Record<string, RateRule> = VOICE_RATE_RULES, private readonly now: () => number = Date.now) {}

  /** Records a hit and returns whether it is allowed, plus seconds until the next slot when it isn't. */
  take(sessionKey: string, bucket: string): { allowed: boolean; retryAfterSecs: number } {
    const rule = this.rules[bucket];
    if (!rule) return { allowed: true, retryAfterSecs: 0 };
    const key = `${bucket}|${sessionKey}`;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < rule.windowMs);
    if (recent.length >= rule.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSecs: Math.max(1, Math.ceil((rule.windowMs - (t - recent[0])) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear(); // bounded memory for a local process
    return { allowed: true, retryAfterSecs: 0 };
  }
}
