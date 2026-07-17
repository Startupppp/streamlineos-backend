import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { RateLimitService } from "./rate-limit.service";
import { RATE_LIMIT_TIER } from "./use-rate-limit.decorator";

function extractClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = raw?.split(",")[0]?.trim() || req.ip;
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
      throw new HttpException({ message: "Rate limit exceeded" }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
