import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import type { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { RateLimitGuard } from "./rate-limit.guard";
import { RateLimitService, effectiveRateLimit } from "./rate-limit.service";
import { RATE_LIMIT_TIER } from "./use-rate-limit.decorator";

interface MockContext {
  ctx: ExecutionContext;
  req: Record<string, unknown>;
  res: { setHeader: jest.Mock };
}

function makeContext(overrides: { userId?: string; ip?: string } = {}): MockContext {
  const req: Record<string, unknown> = {
    user: overrides.userId !== undefined ? { userId: overrides.userId } : undefined,
    ip: overrides.ip ?? "10.0.0.1",
    headers: {},
  };
  const res = { setHeader: jest.fn() };
  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

function makeScanner(): MetadataScanner {
  return {
    getAllMethodNames: (proto: object): string[] => {
      const names: string[] = [];
      let p: object | null = proto;
      while (p && p !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(p)) {
          if (name !== "constructor" && !names.includes(name)) names.push(name);
        }
        p = Object.getPrototypeOf(p) as object | null;
      }
      return names;
    },
  } as unknown as MetadataScanner;
}

function makeDiscovery(instances: object[]): DiscoveryService {
  return {
    getControllers: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
}

describe("RateLimitGuard", () => {
  let reflector: jest.Mocked<Pick<Reflector, "getAllAndOverride">>;
  let rateLimitService: jest.Mocked<Pick<RateLimitService, "check">>;
  let guard: RateLimitGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    rateLimitService = { check: jest.fn() };
    guard = new RateLimitGuard(
      reflector as unknown as Reflector,
      rateLimitService as unknown as RateLimitService,
      makeDiscovery([]),
      makeScanner(),
    );
  });

  it("returns true when no tier metadata is set", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { ctx } = makeContext({ userId: "user1" });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(rateLimitService.check).not.toHaveBeenCalled();
  });

  it("returns true when under the limit (authenticated user keyed by userId)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const { ctx } = makeContext({ userId: "user-abc" });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(rateLimitService.check).toHaveBeenCalledWith("ai:chat", "user-abc");
  });

  it("throws 429 and sets Retry-After header when over the limit (authenticated user)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:invoke");
    rateLimitService.check.mockResolvedValue({ allowed: false, retryAfterSecs: 30 });
    const { ctx, res } = makeContext({ userId: "user-xyz" });
    let thrownStatus: number | undefined;
    let thrownBody: unknown;
    let threw: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      threw = e;
      if (e instanceof HttpException) {
        thrownStatus = e.getStatus();
        thrownBody = e.getResponse();
      }
    }
    expect(threw).toBeInstanceOf(HttpException);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "30");
    expect(thrownStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((thrownBody as { retryAfterSecs: number }).retryAfterSecs).toBe(30);
  });

  it("charges the tier once per request, so a route carrying both the global guard and its own @UseGuards is not billed twice", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const { ctx } = makeContext({ userId: "user-dup" });
    await guard.canActivate(ctx);
    await guard.canActivate(ctx);
    expect(rateLimitService.check).toHaveBeenCalledTimes(1);
  });

  it("charges each separate request from the same user, so the once-per-request latch is not once-per-user", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    await guard.canActivate(makeContext({ userId: "user-dup" }).ctx);
    await guard.canActivate(makeContext({ userId: "user-dup" }).ctx);
    expect(rateLimitService.check).toHaveBeenCalledTimes(2);
  });

  it("keys by client IP when no authenticated user (public route)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:public-kb-ask");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const { ctx } = makeContext({ ip: "203.0.113.5" });
    await guard.canActivate(ctx);
    expect(rateLimitService.check).toHaveBeenCalledWith("ai:public-kb-ask", "203.0.113.5");
  });

  it("reads tier from metadata via Reflector", async () => {
    const setMetaTier = "kb:ask";
    reflector.getAllAndOverride.mockImplementation((key) => {
      if (key === RATE_LIMIT_TIER) return setMetaTier;
      return undefined;
    });
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const { ctx } = makeContext({ userId: "u1" });
    await guard.canActivate(ctx);
    expect(rateLimitService.check).toHaveBeenCalledWith(setMetaTier, "u1");
  });

  it("deduplication prevents double rate-limit consumption when guard runs twice on the same request", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });

    const { ctx, req } = makeContext({ userId: "user-dedup" });
    const sameReqCtx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    await guard.canActivate(sameReqCtx);

    expect(rateLimitService.check).toHaveBeenCalledTimes(1);
  });

  it("does not skip check on a second request with a fresh context", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });

    const { ctx: ctx1 } = makeContext({ userId: "user-fresh" });
    const { ctx: ctx2 } = makeContext({ userId: "user-fresh" });

    await guard.canActivate(ctx1);
    await guard.canActivate(ctx2);

    expect(rateLimitService.check).toHaveBeenCalledTimes(2);
  });
});

describe("RateLimitGuard boot sweep", () => {
  class ValidRateLimitController {
    limitedRoute(): void {}
  }
  Reflect.defineMetadata(
    PATH_METADATA,
    "/limited",
    ValidRateLimitController.prototype.limitedRoute,
  );
  Reflect.defineMetadata(
    RATE_LIMIT_TIER,
    "ai:invoke",
    ValidRateLimitController.prototype.limitedRoute,
  );

  class UnknownTierController {
    badRoute(): void {}
  }
  Reflect.defineMetadata(PATH_METADATA, "/bad", UnknownTierController.prototype.badRoute);
  Reflect.defineMetadata(
    RATE_LIMIT_TIER,
    "completely:unknown:tier:xyz:for:tests",
    UnknownTierController.prototype.badRoute,
  );

  class NoTierController {
    plain(): void {}
  }
  Reflect.defineMetadata(PATH_METADATA, "/plain", NoTierController.prototype.plain);

  function makeGuard(instances: object[]): RateLimitGuard {
    const reflector = new Reflector();
    const rateLimitService = { check: jest.fn() } as unknown as RateLimitService;
    return new RateLimitGuard(reflector, rateLimitService, makeDiscovery(instances), makeScanner());
  }

  it("passes at boot when all declared tiers are known", () => {
    const guard = makeGuard([new ValidRateLimitController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("throws at boot when a route declares an unknown rate-limit tier", () => {
    const guard = makeGuard([new UnknownTierController()]);
    expect(() => guard.onApplicationBootstrap()).toThrow(
      /completely:unknown:tier:xyz:for:tests/,
    );
  });

  it("does not throw when no route has a rate-limit tier", () => {
    const guard = makeGuard([new NoTierController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("the real AppModule registers RateLimitGuard as a global APP_GUARD after JwtAuthGuard", () => {
    const { readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const appModule = readFileSync(
      resolve(__dirname, "../../app.module.ts"),
      "utf8",
    ) as string;
    const globalGuards = [
      ...appModule.matchAll(/APP_GUARD,\s*useClass:\s*(\w+)/g),
    ].map((match) => match[1] as string);

    expect(globalGuards).toContain("RateLimitGuard");

    const jwtIdx = globalGuards.indexOf("JwtAuthGuard");
    const rlIdx = globalGuards.indexOf("RateLimitGuard");
    expect(jwtIdx).toBeGreaterThanOrEqual(0);
    expect(rlIdx).toBeGreaterThan(jwtIdx);
  });
});

describe("TIERS — rate-limit key registration", () => {
  it("search:global resolves to a real tier so the guard is not silently disabled", () => {
    expect(effectiveRateLimit("search:global")).toBeGreaterThan(0);
  });

  it("an unknown key returns 0 (deny), not a positive limit", () => {
    expect(effectiveRateLimit("not-a-real-tier-xyz")).toBe(0);
  });
});
