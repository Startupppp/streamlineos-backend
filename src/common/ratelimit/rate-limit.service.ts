import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "@upstash/redis";
import { REDIS } from "../cache/cache.service";

interface Tier {
  limit: number;
  windowSecs: number;
}

const TIERS: Record<string, Tier> = {
  "api-key-ingest": { limit: 60, windowSecs: 60 },
  "auth:login": { limit: 5, windowSecs: 60 },
  "auth:register": { limit: 3, windowSecs: 60 },
  "auth:forgot-password": { limit: 3, windowSecs: 60 },
  "auth:verify-email": { limit: 10, windowSecs: 60 },
  "auth:resend-verification": { limit: 3, windowSecs: 60 },
  "auth:magic-link": { limit: 3, windowSecs: 60 },
  "auth:magic-link-verify": { limit: 60, windowSecs: 60 },
  "chat:send-message": { limit: 30, windowSecs: 60 },
  "chat:huddle": { limit: 20, windowSecs: 60 },
  "whiteboard:public-view": { limit: 60, windowSecs: 60 },
  "whiteboard:public-edit": { limit: 30, windowSecs: 60 },
  "invite:validate": { limit: 30, windowSecs: 60 },
  "invite:accept": { limit: 10, windowSecs: 60 },
};

const DEV_LIMIT_MULTIPLIER = process.env.NODE_ENV === "production" ? 1 : 10;

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
    const effectiveLimit = t.limit * DEV_LIMIT_MULTIPLIER;
    const now = Date.now();
    const windowMs = t.windowSecs * 1000;
    if (this.redis) {
      const key = `rl:${tier}:${identifier}`;
      try {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, t.windowSecs);
        if (count > effectiveLimit) {
          let ttl = await this.redis.ttl(key);
          if (ttl < 0) {
            await this.redis.expire(key, t.windowSecs);
            ttl = t.windowSecs;
          }
          return { allowed: false, retryAfterSecs: ttl };
        }
        return { allowed: true, retryAfterSecs: 0 };
      } catch {}
    }
    const memKey = `${tier}:${identifier}`;
    const hits = (this.mem.get(memKey) ?? []).filter((ts) => now - ts < windowMs);
    if (hits.length >= effectiveLimit) {
      const oldest = hits[0] ?? now;
      const retryAfterSecs = Math.ceil((windowMs - (now - oldest)) / 1000);
      this.mem.set(memKey, hits);
      return { allowed: false, retryAfterSecs };
    }
    hits.push(now);
    this.mem.set(memKey, hits);
    return { allowed: true, retryAfterSecs: 0 };
  }
}
