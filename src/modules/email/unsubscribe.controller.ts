import { Controller, Get, HttpException, Inject, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { verifyUnsubscribeToken, type UnsubscribePayload } from "./unsubscribe-token";
import { writeUnsubscribeRule } from "./unsubscribe-suppression";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const tokenParams = z.object({ token: z.string().min(1) }).strict();

/**
 * COMP-002. One-click unsubscribe, honoured immediately.
 *
 * `@Public()` because it must work from a mail client with no session — that is the
 * point of one-click. Authentication is the signed token, which names the subject, so
 * it cannot be pointed at another address; the signature and expiry are verified
 * before anything is written.
 *
 * GET IS SAFE, POST MUTATES. RFC 8058 clients POST (`List-Unsubscribe-Post`), and
 * that is the path that applies the opt-out. GET reports what the link would do and
 * writes nothing, because a GET on this URL is issued by things that are not the
 * recipient: corporate link scanners (Safe Links, gateway URL rewriting), mail
 * previewers and browser prefetch all fetch it on receipt. A GET that unsubscribed
 * meant the security appliance opted the user out of their own mail.
 *
 * WHERE THE OPT-OUT IS RECORDED. In `notification_suppression_rules`, at the scope
 * the token names — not in `email_suppressions`. See `unsubscribe-suppression.ts`
 * for why: that table is the deliverability list, it is applied to mandatory mail by
 * design, and it has no reversal path.
 */
@Public()
@Controller("notifications/unsubscribe")
export class UnsubscribeController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get(":token")
  @Validate({ params: tokenParams })
  get(@Param("token") token: string, @Req() req: Request) {
    return this.handle(token, req, false);
  }

  @Post(":token")
  @BodylessAction()
  @Validate({ params: tokenParams })
  post(@Param("token") token: string, @Req() req: Request) {
    return this.handle(token, req, true);
  }

  private async handle(token: string, req: Request, apply: boolean) {
    // The tier is registered in TIERS — without an entry check() would return
    // allowed for an unknown key and this guard would silently do nothing.
    const limit = await this.rateLimit.check("notifications:unsubscribe", req.ip ?? "unknown");
    if (!limit.allowed) throw new HttpException("Too many requests", 429);

    const payload = verifyUnsubscribeToken(token);
    // Deliberately the same response for an invalid, tampered or expired token as for
    // an unknown one: this endpoint is unauthenticated, and distinguishing them would
    // turn it into an oracle for which addresses exist.
    if (!payload) return { ok: false, applied: false, message: "This unsubscribe link is invalid or has expired." };

    if (!apply)
      return {
        ok: true,
        applied: false,
        scope: payload.scope,
        message: "Confirm to stop receiving these emails.",
      };

    const written = await this.apply(payload);

    return {
      ok: true,
      applied: true,
      scope: payload.scope,
      message: written.created
        ? "You have been unsubscribed. This takes effect immediately."
        : "You are already unsubscribed from these emails.",
    };
  }

  /**
   * The route is `@Public()`, so `TenantContextInterceptor` opens no tenant
   * transaction and `createTenantAwareDb` hands back the raw pool with
   * `app.organization_id` unset. Every table this write touches is behind
   * `org_id = app.current_org_id()`, and that function RAISES 42501 rather than
   * returning NULL — which is why the previous shape answered 500 to every click
   * and suppressed nothing. The tenant comes from the token, whose signature was
   * verified above, so it cannot be pointed at another organisation.
   */
  private apply(payload: UnsubscribePayload) {
    return runInNewTenantTransaction(this.db, payload.orgId, (tx) =>
      writeUnsubscribeRule(tx, payload),
    );
  }
}
