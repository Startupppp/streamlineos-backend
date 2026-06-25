import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { REDIS } from "../cache/cache.service";

interface Tier {
  limit: number;
  windowSecs: number;
}

const TIERS: Record<string, Tier> = {
  "api-key-ingest": { limit: 60, windowSecs: 60 },
};

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSecs: number;
}

@Injectable()
export class RateLimitService {
  private readonly mem = new Map<string, number[]>();
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  async check(tier: string, identifier: string): Promise<RateLimitResult> {
    const t = TIERS[tier];
    if (!t) return { allowed: true, retryAfterSecs: 0 };
    const now = Date.now();
    const windowMs = t.windowSecs * 1000;
    if (this.redis) {
      const key = `rl:${tier}:${identifier}`;
      try {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, t.windowSecs);
        if (count > t.limit) {
          const ttl = await this.redis.ttl(key);
          return { allowed: false, retryAfterSecs: ttl > 0 ? ttl : t.windowSecs };
        }
        return { allowed: true, retryAfterSecs: 0 };
      } catch {}
    }
    const hits = (this.mem.get(identifier) ?? []).filter((ts) => now - ts < windowMs);
    if (hits.length >= t.limit) {
      const retryAfterSecs = Math.ceil((windowMs - (now - hits[0])) / 1000);
      this.mem.set(identifier, hits);
      return { allowed: false, retryAfterSecs };
    }
    hits.push(now);
    this.mem.set(identifier, hits);
    return { allowed: true, retryAfterSecs: 0 };
  }
}
