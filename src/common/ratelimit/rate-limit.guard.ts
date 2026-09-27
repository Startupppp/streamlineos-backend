import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { CurrentUserContext } from "../auth/backend-claims";
import { isKnownTier, RateLimitService } from "./rate-limit.service";
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

const RATE_LIMIT_CHECKED = Symbol("rate-limit-checked");

@Injectable()
export class RateLimitGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimitService: RateLimitService,
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const unknown: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== "object") continue;

      const proto: object = Object.getPrototypeOf(instance);
      const classRef = proto.constructor;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler: unknown = Reflect.get(proto, methodName);
        if (typeof handler !== "function") continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const tier = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_TIER, [
          handler,
          classRef,
        ]);
        if (tier === undefined) continue;

        if (!isKnownTier(tier)) {
          unknown.push(`${classRef.name}#${methodName} declares unknown tier "${tier}"`);
        }
      }
    }

    if (unknown.length === 0) {
      this.logger.log("RateLimitGuard: every @UseRateLimit tier is registered in TIERS");
      return;
    }

    const list = unknown.sort().join("\n  ");
    throw new Error(
      `RateLimitGuard: ${unknown.length} route(s) declare an unknown rate-limit tier — add each to TIERS in rate-limit.service.ts:\n  ${list}`,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tier = this.reflector.getAllAndOverride<string | undefined>(RATE_LIMIT_TIER, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!tier) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: CurrentUserContext; [RATE_LIMIT_CHECKED]?: true }>();

    if (req[RATE_LIMIT_CHECKED]) return true;
    req[RATE_LIMIT_CHECKED] = true;

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
