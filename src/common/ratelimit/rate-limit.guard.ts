import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { RateLimitService } from "./rate-limit.service";
import { RATE_LIMIT_TIER } from "./use-rate-limit.decorator";

/**
 * The bucket key for an unauthenticated caller.
 *
 * Reads `req.ip` and nothing else. It used to prefer the forwarded-for header's LEFTMOST entry,
 * which is the hop the CLIENT wrote — a proxy appends, it does not prepend — so rotating one
 * header defeated every unauthenticated tier: 150 requests, 0 blocked, against 120 blocked
 * from a fixed hop. Express resolves `req.ip` under the `trust proxy` hop count declared in
 * `common/http/trust-proxy.ts`, which is counted from the RIGHT and therefore unforgeable.
 */
function extractClientIp(req: Request): string {
  const candidate = req.ip;
  return candidate ? candidate.slice(0, 100) : "unknown";
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tier = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_TIER, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!tier) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: CurrentUserContext }>();
    const identifier = req.user?.userId ?? extractClientIp(req);

    const result = await this.rateLimitService.check(tier, identifier);
    if (!result.allowed) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader("Retry-After", String(result.retryAfterSecs));
      throw new HttpException(
        { message: "Rate limit exceeded", retryAfterSecs: result.retryAfterSecs },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
