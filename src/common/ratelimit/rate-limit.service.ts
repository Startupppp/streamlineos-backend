import { Inject, Injectable, Logger } from "@nestjs/common";
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
  "auth:verify-email": { limit: 10, windowSecs: 60 },
  "auth:resend-verification": { limit: 3, windowSecs: 60 },
  "auth:magic-link": { limit: 3, windowSecs: 60 },
  "auth:magic-link-verify": { limit: 60, windowSecs: 60 },
  "auth:email-otp": { limit: 3, windowSecs: 600 },
  "auth:email-otp-verify": { limit: 10, windowSecs: 600 },
  "public:contact": { limit: 5, windowSecs: 3600 },
  "public:waitlist": { limit: 5, windowSecs: 3600 },
  "chat:send-message": { limit: 30, windowSecs: 60 },
  "chat:huddle": { limit: 20, windowSecs: 60 },
  "chat:huddle-signal": { limit: 240, windowSecs: 60 },
  "chat:huddle-heartbeat": { limit: 10, windowSecs: 60 },
  "whiteboard:public-view": { limit: 60, windowSecs: 60 },
  "whiteboard:public-edit": { limit: 30, windowSecs: 60 },
  "invite:validate": { limit: 30, windowSecs: 60 },
  "invite:accept": { limit: 10, windowSecs: 60 },
  "survey:public-view": { limit: 60, windowSecs: 60 },
  "survey:public-start": { limit: 20, windowSecs: 60 },
  "survey:public-submit": { limit: 20, windowSecs: 60 },
  "support:portal-ticket-create": { limit: 10, windowSecs: 3600 },
  "support:inbound-email": { limit: 120, windowSecs: 60 },
  "support:inbound-whatsapp": { limit: 120, windowSecs: 60 },
  "support:inbound-sms": { limit: 120, windowSecs: 60 },
  "support:chat-widget": { limit: 60, windowSecs: 60 },
  "feedbucket:widget-submit": { limit: 10, windowSecs: 60 },
  "feedbucket:widget-config": { limit: 60, windowSecs: 60 },
  "feedbucket:ai-analyze": { limit: 20, windowSecs: 60 },
  "feedbucket:ai-assist": { limit: 5, windowSecs: 60 },
  "feedbucket:ai-assist-daily": { limit: 200, windowSecs: 86400 },
  "sign:public-session": { limit: 60, windowSecs: 60 },
  "sign:public-auth": { limit: 10, windowSecs: 60 },
  "sign:public-otp-request": { limit: 5, windowSecs: 3600 },
  "sign:public-complete": { limit: 10, windowSecs: 60 },
  "sign:public-form-submit": { limit: 10, windowSecs: 3600 },
  "sign:bulk-send-create": { limit: 5, windowSecs: 3600 },
  "mail:send": { limit: 30, windowSecs: 60 },
  "mail:reply": { limit: 30, windowSecs: 60 },
  "ai:invoke": { limit: 30, windowSecs: 60 },
  "ai:chat": { limit: 20, windowSecs: 60 },
  "ai:vision": { limit: 10, windowSecs: 60 },
  "ai:public-kb-ask": { limit: 10, windowSecs: 60 },
  "kb:ask": { limit: 20, windowSecs: 60 },
  "module-access:ownership-transfer": { limit: 5, windowSecs: 3600 },
  "module-access:group-mutate": { limit: 30, windowSecs: 60 },
  "ownership:transfer": { limit: 5, windowSecs: 3600 },
  "ownership:force-set": { limit: 10, windowSecs: 3600 },
};

const DEV_LIMIT_MULTIPLIER = process.env.NODE_ENV === "production" ? 1 : 10;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSecs: number;
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
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
      } catch (err) {
        this.logger.warn(`Redis rate-limit failed for ${tier}:${identifier}, falling back to in-memory: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const memKey = `${tier}:${identifier}`;
    const raw = this.mem.get(memKey);
    const hits = (raw ?? []).filter((ts) => now - ts < windowMs);
    if (hits.length === 0 && raw !== undefined) this.mem.delete(memKey);
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
