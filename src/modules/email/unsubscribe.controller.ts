import { Controller, Get, HttpException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../../common/auth/public.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { EmailSuppressionService } from "./email-suppression.service";
import { verifyUnsubscribeToken } from "./unsubscribe-token";

/**
 * COMP-002. One-click unsubscribe, honoured immediately.
 *
 * `@Public()` because it must work from a mail client with no session — that is the
 * point of one-click. Authentication is the signed token, which names the subject, so
 * it cannot be pointed at another address.
 *
 * POST exists for RFC 8058 `List-Unsubscribe-Post`; GET exists because some clients
 * and most humans follow the link. Both are idempotent.
 */
@Public()
@Controller("notifications/unsubscribe")
export class UnsubscribeController {
  constructor(
    private readonly suppression: EmailSuppressionService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get(":token")
  get(@Param("token") token: string, @Req() req: Request) {
    return this.handle(token, req);
  }

  @Post(":token")
  post(@Param("token") token: string, @Req() req: Request) {
    return this.handle(token, req);
  }

  private async handle(token: string, req: Request) {
    // The tier is registered in TIERS — without an entry check() would return
    // allowed for an unknown key and this guard would silently do nothing.
    const limit = await this.rateLimit.check("notifications:unsubscribe", req.ip ?? "unknown");
    if (!limit.allowed) throw new HttpException("Too many requests", 429);

    const payload = verifyUnsubscribeToken(token);
    // Deliberately the same response for an invalid, tampered or expired token as for
    // an unknown one: this endpoint is unauthenticated, and distinguishing them would
    // turn it into an oracle for which addresses exist.
    if (!payload) return { ok: false, message: "This unsubscribe link is invalid or has expired." };

    await this.suppression.suppress({
      email: payload.email,
      // Scoped to the tenant that sent it — unsubscribing from one workspace must not
      // silence a different employer using the same address.
      orgId: payload.orgId,
      reason: "UNSUBSCRIBE",
      source: "USER",
      evidence: { scope: payload.scope, scopeKey: payload.scopeKey, userId: payload.userId },
    });

    return {
      ok: true,
      message: "You have been unsubscribed. This takes effect immediately.",
      scope: payload.scope,
    };
  }
}
