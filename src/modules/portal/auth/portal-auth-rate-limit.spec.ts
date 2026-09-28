import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import type { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { z } from "zod";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import {
  RateLimitService,
  effectiveRateLimit,
  isKnownTier,
  rateLimitWindowSecs,
} from "../../../common/ratelimit/rate-limit.service";
import { RATE_LIMIT_TIER } from "../../../common/ratelimit/use-rate-limit.decorator";
import { PortalAuthController } from "./portal-auth.controller";

const TIER = "portal:accept-invitation";
const MISSPELLED_TIER = "portal:accept-invitaton";
const SIBLING_TIER = "invite:accept";

const rateLimitBody = z
  .object({ message: z.string().min(1), retryAfterSecs: z.number().int().positive() })
  .strict();

interface MockContext {
  ctx: ExecutionContext;
  res: { setHeader: jest.Mock };
}

function makeContext(handler: object, classRef: object, ip: string): MockContext {
  const req: Record<string, unknown> = { ip, headers: {} };
  const res = { setHeader: jest.fn() };
  const ctx = {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, res };
}

function makeScanner(): MetadataScanner {
  return {
    getAllMethodNames: (proto: object): string[] =>
      Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor"),
  } as unknown as MetadataScanner;
}

function makeDiscovery(instances: object[]): DiscoveryService {
  return {
    getControllers: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
}

function makeGuard(instances: object[] = []): RateLimitGuard {
  return new RateLimitGuard(
    new Reflector(),
    new RateLimitService(null),
    makeDiscovery(instances),
    makeScanner(),
  );
}

function catchHttp(run: () => Promise<unknown>): Promise<HttpException | undefined> {
  return run().then(
    () => undefined,
    (err: unknown) => (err instanceof HttpException ? err : undefined),
  );
}

const acceptHandler: object = PortalAuthController.prototype.acceptInvitation;

class MisspelledTierController {
  acceptInvitation(): void {}
}
Reflect.defineMetadata(
  PATH_METADATA,
  "accept-invitation",
  MisspelledTierController.prototype.acceptInvitation,
);
Reflect.defineMetadata(
  RATE_LIMIT_TIER,
  MISSPELLED_TIER,
  MisspelledTierController.prototype.acceptInvitation,
);

describe("POST /portal/auth/accept-invitation is rate limited", () => {
  it("declares a rate-limit tier on the handler, which is what the unlimited route lacked", () => {
    expect(Reflect.getMetadata(PATH_METADATA, acceptHandler)).toBe("accept-invitation");
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, acceptHandler)).toBe(TIER);
  });

  it("resolves that tier in TIERS, so the boot sweep admits the route instead of refusing it", () => {
    expect(isKnownTier(TIER)).toBe(true);
    expect(effectiveRateLimit(TIER)).toBeGreaterThan(0);
    expect(rateLimitWindowSecs(TIER)).toBe(60);
  });

  it("would not resolve a misspelt tier, so the spelling above is proven and not assumed", () => {
    expect(isKnownTier(MISSPELLED_TIER)).toBe(false);
    expect(effectiveRateLimit(MISSPELLED_TIER)).toBe(0);
  });

  it("matches the unauthenticated token-claim sibling POST /organizations/invitations/accept", () => {
    expect(effectiveRateLimit(TIER)).toBe(effectiveRateLimit(SIBLING_TIER));
    expect(rateLimitWindowSecs(TIER)).toBe(rateLimitWindowSecs(SIBLING_TIER));
  });

  it("admits the real controller through the boot sweep that refuses an unregistered tier", () => {
    const service = { acceptInvitation: jest.fn() };
    const controller = new PortalAuthController(
      service as unknown as ConstructorParameters<typeof PortalAuthController>[0],
    );
    expect(() => makeGuard([controller]).onApplicationBootstrap()).not.toThrow();
    expect(() => makeGuard([new MisspelledTierController()]).onApplicationBootstrap()).toThrow(
      new RegExp(MISSPELLED_TIER),
    );
  });

  it("allows every call up to the effective limit, then answers exactly 429 with { message, retryAfterSecs }", async () => {
    const guard = makeGuard();
    const limit = effectiveRateLimit(TIER);
    const ip = "198.51.100.7";

    for (let i = 0; i < limit; i++) {
      const { ctx } = makeContext(acceptHandler, PortalAuthController, ip);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }

    const { ctx, res } = makeContext(acceptHandler, PortalAuthController, ip);
    const thrown = await catchHttp(() => guard.canActivate(ctx));

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    const body = rateLimitBody.parse(thrown?.getResponse());
    expect(body.retryAfterSecs).toBeLessThanOrEqual(rateLimitWindowSecs(TIER));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", String(body.retryAfterSecs));
  });

  it("buckets per caller, so one exhausted IP does not 429 a different client", async () => {
    const guard = makeGuard();
    const limit = effectiveRateLimit(TIER);

    for (let i = 0; i < limit + 1; i++) {
      const { ctx } = makeContext(acceptHandler, PortalAuthController, "203.0.113.11");
      await guard.canActivate(ctx).catch(() => undefined);
    }

    const { ctx } = makeContext(acceptHandler, PortalAuthController, "203.0.113.12");
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("denies from the first call when the tier name is unregistered, so a typo is an outage and never silent exposure", async () => {
    const guard = makeGuard();
    const { ctx } = makeContext(
      MisspelledTierController.prototype.acceptInvitation,
      MisspelledTierController,
      "198.51.100.9",
    );
    const thrown = await catchHttp(() => guard.canActivate(ctx));

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(rateLimitBody.parse(thrown?.getResponse()).retryAfterSecs).toBeGreaterThan(0);
  });
});
