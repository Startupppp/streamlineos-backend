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
  // Provider bounce/complaint callbacks. Generous — a real provider can burst — but
  // bounded so an attacker who obtains the signing secret cannot flood the write path.
  "webhook:email": { limit: 600, windowSecs: 60 },
  // SEC-004. These three were called with no TIERS entry, so check() returned
  // allowed for an unknown key and the guard was a no-op while looking protected.
  // Both hr-form routes are @Public() and one of them writes.
  "hr-form:public-view": { limit: 60, windowSecs: 60 },
  "hr-form:public-submit": { limit: 5, windowSecs: 3600 },
  "platform-visit": { limit: 120, windowSecs: 60 },
  // COMP-002. @Public() one-click unsubscribe; generous enough for a mail client
  // prefetching the link, bounded against enumeration.
  "notifications:unsubscribe": { limit: 30, windowSecs: 60 },
  // SSE stream token: one token per reconnect. 30/min is ample for legitimate
  // reconnects but stops a script inflating the in-process token map.
  "notifications:stream-token": { limit: 30, windowSecs: 60 },
  "public:contact": { limit: 5, windowSecs: 3600 },
  "public:waitlist": { limit: 5, windowSecs: 3600 },
  "public:kb": { limit: 60, windowSecs: 60 },
  "public:kb-article": { limit: 60, windowSecs: 60 },
  "public:roadmap": { limit: 60, windowSecs: 60 },
  "public:roadmap-vote": { limit: 10, windowSecs: 3600 },
  "public:roadmap-feedback": { limit: 5, windowSecs: 3600 },
  "chat:send-message": { limit: 30, windowSecs: 60 },
  "chat:huddle": { limit: 20, windowSecs: 60 },
  "chat:huddle-signal": { limit: 240, windowSecs: 60 },
  "chat:huddle-heartbeat": { limit: 10, windowSecs: 60 },
  "whiteboard:public-view": { limit: 60, windowSecs: 60 },
  "whiteboard:public-edit": { limit: 30, windowSecs: 60 },
  "organization:create": { limit: 5, windowSecs: 3600 },
  "invite:validate": { limit: 30, windowSecs: 60 },
  "invite:accept": { limit: 10, windowSecs: 60 },
  "survey:public-view": { limit: 60, windowSecs: 60 },
  "survey:public-start": { limit: 20, windowSecs: 60 },
  "survey:public-submit": { limit: 20, windowSecs: 60 },
  "support:csat-view": { limit: 60, windowSecs: 60 },
  "support:csat-submit": { limit: 5, windowSecs: 3600 },
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
  "hr:attendance-report": { limit: 5, windowSecs: 3600 },
  "hr:employee-backfill": { limit: 3, windowSecs: 3600 },
  "hr:employee-bulk-onboard": { limit: 10, windowSecs: 3600 },
  "hr:employee-export": { limit: 5, windowSecs: 3600 },
  "hr:effective-changes-apply": { limit: 10, windowSecs: 3600 },
  "hr:onboarding-reminders": { limit: 3, windowSecs: 3600 },
  "ai:invoke": { limit: 30, windowSecs: 60 },
  "ai:chat": { limit: 20, windowSecs: 60 },
  "ai:vision": { limit: 10, windowSecs: 60 },
  "ai:public-kb-ask": { limit: 10, windowSecs: 60 },
  "kb:ask": { limit: 20, windowSecs: 60 },
  "module-access:ownership-transfer": { limit: 5, windowSecs: 3600 },
  "module-access:group-mutate": { limit: 30, windowSecs: 60 },
  "ownership:transfer": { limit: 5, windowSecs: 3600 },
  "ownership:force-set": { limit: 10, windowSecs: 3600 },
  "crm:public-unsubscribe": { limit: 20, windowSecs: 3600 },
  "public:application-status": { limit: 30, windowSecs: 60 },
  "public:offer": { limit: 30, windowSecs: 60 },
  "public:offer-respond": { limit: 5, windowSecs: 3600 },
  "public:referrer-portal": { limit: 30, windowSecs: 60 },
  "public:referral-submit": { limit: 5, windowSecs: 3600 },
  "public:vendor-portal": { limit: 30, windowSecs: 60 },
  // Payment webhooks are @Public and unauthenticated — bounded per IP to prevent
  // a forged-signature flood from locking up the write path. Generous enough for
  // a real provider that can burst at retry time.
  "billing:webhook": { limit: 600, windowSecs: 60 },
  // Checkout creates a provider order; 5/hour per user prevents order flooding
  // while leaving headroom for legitimate retries with different plans.
  "billing:checkout": { limit: 5, windowSecs: 3600 },
  // Vector ANN search under RLS is the highest-cost read in the system.
  // 30 calls/min per user matches the AI chat tier and leaves room for typeahead
  // without letting a single user monopolise the embedding + ANN budget.
  "search:global": { limit: 30, windowSecs: 60 },
  "public:job-apply": { limit: 3, windowSecs: 3600 },
  "public:referrer-register": { limit: 3, windowSecs: 3600 },
  "public:intake": { limit: 5, windowSecs: 3600 },
  "public:form-submit": { limit: 5, windowSecs: 3600 },
  "public:lead-form-submit": { limit: 5, windowSecs: 3600 },
  "public:nps-submit": { limit: 5, windowSecs: 3600 },
  "public:kb-feedback": { limit: 10, windowSecs: 3600 },
  "public:org-info": { limit: 60, windowSecs: 60 },
  "public:careers-list": { limit: 60, windowSecs: 60 },
  "public:careers-job": { limit: 60, windowSecs: 60 },
  "public:interview-booking": { limit: 30, windowSecs: 60 },
  "public:nps-view": { limit: 30, windowSecs: 60 },
  "public:form-view": { limit: 30, windowSecs: 60 },
  "public:lead-form-view": { limit: 30, windowSecs: 60 },
  "blog:public-read": { limit: 60, windowSecs: 60 },
};

const DEV_LIMIT_MULTIPLIER = process.env.NODE_ENV === "production" ? 1 : 10;

/**
 * The limit actually enforced right now. Outside production every tier is
 * multiplied so local work is not throttled, which means a test that hard-codes
 * the declared limit exhausts a tenth of the real budget and never sees a 429.
 */
export function effectiveRateLimit(tier: string): number {
  const t = TIERS[tier];
  return t ? t.limit * DEV_LIMIT_MULTIPLIER : 0;
}

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
    // SEC-004. This used to `return { allowed: true }`, so a decorator or a call
    // with a typo'd or unregistered tier looked protected in review and silently
    // was not — which is how hr-form:public-view, hr-form:public-submit and
    // platform-visit ran unlimited. Deny-by-default (§20): every tier reaching this
    // method has been enumerated and declared, so an unknown one is a bug, and a
    // 429 is trivially reversible by adding the entry. Silent exposure is not.
    if (!t) {
      this.logger.error(
        `Unknown rate-limit tier "${tier}" — denying. Add it to TIERS in rate-limit.service.ts.`,
      );
      return { allowed: false, retryAfterSecs: 60 };
    }
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
        this.logger.warn(
          `Redis rate-limit failed for ${tier}:${identifier}, falling back to in-memory: ${err instanceof Error ? err.message : String(err)}`,
        );
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
