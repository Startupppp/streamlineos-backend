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
  "auth:verify-email": { limit: 10, windowSecs: 60 },
  "auth:resend-verification": { limit: 3, windowSecs: 60 },
  "auth:magic-link": { limit: 3, windowSecs: 60 },
  "auth:magic-link-verify": { limit: 60, windowSecs: 60 },
  "auth:email-otp": { limit: 20, windowSecs: 600 },
  "auth:email-otp:email": { limit: 5, windowSecs: 600 },
  "auth:email-otp-verify": { limit: 40, windowSecs: 600 },
  "auth:email-otp-verify:email": { limit: 10, windowSecs: 600 },
  // TOTP has a 30s step and otplib accepts one step either side, so a code stays
  // valid long enough for an unthrottled loop to walk a meaningful slice of the
  // 10^6 space. Keyed per user, not per IP.
  "auth:mfa-verify": { limit: 10, windowSecs: 300 },
  // The three INTERNAL_API_SECRET routes. They were the only @Public() routes on
  // auth.controller.ts with no limiter at all, so a leaked shared secret minted
  // sessions unbounded. Keyed on the SUBJECT, not the source: the caller is the
  // web tier, so every request shares one server IP and a per-IP tier would be a
  // single global bucket. Generous enough that no real user reaches them.
  "auth:google": { limit: 10, windowSecs: 60 },
  "auth:session-exchange": { limit: 300, windowSecs: 60 },
  "auth:session-data": { limit: 300, windowSecs: 60 },
  "auth:mfa-disable": { limit: 10, windowSecs: 300 },
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
  // Read-only marketing reads. Generous: an evaluation reloads a pricing page.
  "public:pricing": { limit: 120, windowSecs: 60 },
  // The subprocessor register is @Public() because the people who read it are a
  // prospect's counsel and a customer's compliance officer, who have no login.
  // The read is generous; the subscribe is an unauthenticated write taking an
  // email address, which is the shape of every mailing-list abuse there is.
  "compliance:subprocessors": { limit: 60, windowSecs: 60 },
  "compliance:subscribe": { limit: 5, windowSecs: 3600 },
  "public:waitlist": { limit: 5, windowSecs: 3600 },
  /**
   * Claiming an invitation, which is unauthenticated and creates an
   * organisation. Tighter than joining the waitlist because the failure mode is
   * worse: the endpoint is a token oracle, and a wrong guess is cheap for an
   * attacker and free for us to refuse. Ten an hour is generous for somebody
   * mistyping their own details and useless for enumeration.
   */
  "public:waitlist-claim": { limit: 10, windowSecs: 3600 },
  "public:kb": { limit: 60, windowSecs: 60 },
  "public:kb-article": { limit: 60, windowSecs: 60 },
  "public:roadmap": { limit: 60, windowSecs: 60 },
  "public:roadmap-vote": { limit: 10, windowSecs: 3600 },
  "public:roadmap-feedback": { limit: 5, windowSecs: 3600 },
  "chat:send-message": { limit: 30, windowSecs: 60 },
  "chat:huddle": { limit: 20, windowSecs: 60 },
  "chat:huddle-heartbeat": { limit: 10, windowSecs: 60 },
  "whiteboard:public-view": { limit: 60, windowSecs: 60 },
  "whiteboard:public-edit": { limit: 30, windowSecs: 60 },
  "organization:create": { limit: 5, windowSecs: 3600 },
  "invite:validate": { limit: 30, windowSecs: 60 },
  "invite:accept": { limit: 10, windowSecs: 60 },
  "invite:reissue-link": { limit: 10, windowSecs: 300 },
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
  "sign:bulk-send-create": { limit: 5, windowSecs: 3600 },
  // A "send me a test" button on a template preview. It used to take an
  // arbitrary destination with no limiter, so one holder of
  // settings:email-templates:manage could aim the platform sender anywhere,
  // repeatedly. The destination is now the caller's own address; 5/hour is
  // ample for a person checking a template and useless for a flood.
  "settings:email-template-test": { limit: 5, windowSecs: 3600 },
  "mail:send": { limit: 30, windowSecs: 60 },
  "mail:reply": { limit: 30, windowSecs: 60 },
  // An arbitrary To:, an arbitrary subject and arbitrary HTML, sent from the
  // platform's own sender. Its sibling settings/email-templates/test has been
  // limited since it could aim the sender anywhere; this route could do the same
  // thing with a free-form body and carried no limiter at all. 60/hour is more
  // than a recruiter working a pipeline needs and far short of a flood.
  "hr:communications-send": { limit: 60, windowSecs: 3600 },
  "hr:attendance-report": { limit: 5, windowSecs: 3600 },
  "hr:employee-backfill": { limit: 3, windowSecs: 3600 },
  "hr:employee-bulk-onboard": { limit: 10, windowSecs: 3600 },
  // HRM-15. A preview writes nothing but parses and validates up to 100 (onboarding) or 500
  // (reassignment) rows in a constant number of queries; sharing the commit tier would spend the
  // commit budget on dry runs, so previews get their own, looser tier.
  "hr:employee-bulk-onboard-preview": { limit: 60, windowSecs: 3600 },
  "hr:reporting-line-bulk-preview": { limit: 30, windowSecs: 3600 },
  "hr:reporting-line-bulk-commit": { limit: 10, windowSecs: 3600 },
  "hr:employee-export": { limit: 5, windowSecs: 3600 },
  // Minting a join link hands out a working credential, so the limit is what an
  // administrator onboarding a batch by hand plausibly needs and no more —
  // enough for a morning's work, low enough that a stolen session cannot walk
  // the directory harvesting links.
  "hr:employee-invite-link": { limit: 20, windowSecs: 3600 },
  // V-030. Its sibling invite-link has been limited since it mints a working
  // credential; resend-invite mints the same credential AND mails it, and
  // carried no limiter at all — a stolen session could walk the directory
  // spraying invite mail from the platform's own sender. Five an hour is more
  // than an administrator correcting a typo needs.
  "hr:employee-resend-invite": { limit: 5, windowSecs: 3600 },
  "hr:effective-changes-apply": { limit: 10, windowSecs: 3600 },
  "hr:onboarding-reminders": { limit: 3, windowSecs: 3600 },
  "ai:invoke": { limit: 30, windowSecs: 60 },
  "ai:chat": { limit: 20, windowSecs: 60 },
  "ai:vision": { limit: 10, windowSecs: 60 },
  "ai:public-kb-ask": { limit: 10, windowSecs: 60 },
  "ai:public-kb-ask:org": { limit: 60, windowSecs: 60 },
  "kb:ask": { limit: 20, windowSecs: 60 },
  "kb:ask:org": { limit: 200, windowSecs: 60 },
  "kb:linked-document-open": { limit: 30, windowSecs: 60 },
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
  // INV-26. Carrier status callbacks are @Public and unauthenticated, and the
  // signature is checked before anything is written — so the limit is not the
  // security boundary, it is what stops a forged-signature flood occupying the
  // write path. Sized like the payment one: a courier draining its retry queue
  // after an outage bursts, and a warehouse's whole day of parcels is far under
  // 600 a minute.
  "inventory:carrier-webhook": { limit: 600, windowSecs: 60 },
  // Checkout creates a provider order; 5/hour per user prevents order flooding
  // while leaving headroom for legitimate retries with different plans.
  "billing:checkout": { limit: 5, windowSecs: 3600 },
  // Confirmation submits a provider signature, so it is the one billing write an
  // attacker can replay against. Looser than checkout because a network blip during
  // payment is normal and a blocked confirmation strands a paid customer.
  "billing:confirm": { limit: 20, windowSecs: 3600 },
  // Vector ANN search under RLS is the highest-cost read in the system.
  // 30 calls/min per user matches the AI chat tier and leaves room for typeahead
  // without letting a single user monopolise the embedding + ANN budget.
  "search:global": { limit: 30, windowSecs: 60 },
  "public:job-apply": { limit: 3, windowSecs: 3600 },
  // POST /public/board-apply/:orgSlug/:platform is a machine callback, not a
  // human form, so the 3/hour human tier would drop a board's normal traffic on
  // a popular role. It is HMAC-verified before anything is written, so the limit
  // is a flood ceiling rather than the authorisation — generous enough for a
  // real board, small enough that an unsigned flood cannot become a workload.
  "public:board-apply": { limit: 300, windowSecs: 3600 },
  /**
   * An agency pushes a handful of verdicts per case, not a stream. 120 an hour
   * is generous for a real integration and small enough that a leaked callback
   * URL cannot be used to hammer the signature check.
   */
  "public:bgv-callback": { limit: 120, windowSecs: 3600 },
  /** One score per invitation, plus retries. 300 an hour covers a campus drive. */
  "public:assessment-score": { limit: 300, windowSecs: 3600 },
  /** One result per call, plus retries. */
  "public:voice-screen-result": { limit: 300, windowSecs: 3600 },
  /** Candidates reply in bursts; a busy tenant sees a few hundred an hour. */
  "public:whatsapp-inbound": { limit: 600, windowSecs: 3600 },
  // POST /csat/:surveyId/responses is @Public and unauthenticated, and it is the
  // SECOND CSAT submit surface in the repository. The first, support-csat, is
  // "support:csat-submit" at 5/hour; this one carried nothing, so a survey id is
  // an unbounded write. Matched to the sibling rather than invented.
  "csat:submit": { limit: 5, windowSecs: 3600 },
  // POST /internal/audit is the FOURTH INTERNAL_API_SECRET route. The other three
  // (auth:google, auth:session-exchange, auth:session-data) were limited precisely
  // because a leaked shared secret is otherwise unbounded; this one was missed, so
  // a leaked secret floods the audit log. Webhook order, because a real internal
  // caller bursts: the same 600/60 as "webhook:email" and "billing:webhook".
  "internal:audit": { limit: 600, windowSecs: 60 },
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
  // Build Phase 5: automation runner has no HTTP entry point of its own — it fires
  // from ticket-write call sites via `runForTicketEvent` — so `BuildAutomationRunnerService`
  // calls `RateLimitService.check` directly rather than through `@UseRateLimit`.
  // Keyed per (org, project) rather than per actor, because a bulk import or a
  // scripted client hammering one project's tickets is what would otherwise run
  // every configured rule unbounded; 300/min is generous for real ticket traffic
  // and bounded against a runaway loop the depth guard did not catch.
  "build:automation-run": { limit: 300, windowSecs: 60 },
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

export function rateLimitWindowSecs(tier: string): number {
  const t = TIERS[tier];
  return t ? t.windowSecs : 60;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSecs: number;
}

interface MemoryWindow {
  hits: number[];
  expiresAt: number;
}

const MEM_SWEEP_INTERVAL_MS = 60_000;
const MEM_MAX_KEYS = 50_000;

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly mem = new Map<string, MemoryWindow>();
  private lastSweepAt = 0;
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}

  memoryKeyCount(): number {
    return this.mem.size;
  }

  private sweepMemory(now: number): void {
    if (
      now - this.lastSweepAt < MEM_SWEEP_INTERVAL_MS &&
      this.mem.size <= MEM_MAX_KEYS
    )
      return;
    this.lastSweepAt = now;

    for (const [key, window] of this.mem)
      if (window.expiresAt <= now) this.mem.delete(key);

    if (this.mem.size <= MEM_MAX_KEYS) return;
    let overflow = this.mem.size - MEM_MAX_KEYS;
    for (const key of this.mem.keys()) {
      if (overflow <= 0) break;
      this.mem.delete(key);
      overflow -= 1;
    }
  }

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
    this.sweepMemory(now);

    const memKey = `${tier}:${identifier}`;
    const existing = this.mem.get(memKey);
    const hits = (existing?.hits ?? []).filter((ts) => now - ts < windowMs);
    if (hits.length === 0 && existing !== undefined) this.mem.delete(memKey);
    if (hits.length >= effectiveLimit) {
      const oldest = hits[0] ?? now;
      const retryAfterSecs = Math.ceil((windowMs - (now - oldest)) / 1000);
      this.mem.set(memKey, { hits, expiresAt: now + windowMs });
      return { allowed: false, retryAfterSecs };
    }
    hits.push(now);
    this.mem.set(memKey, { hits, expiresAt: now + windowMs });
    return { allowed: true, retryAfterSecs: 0 };
  }
}
