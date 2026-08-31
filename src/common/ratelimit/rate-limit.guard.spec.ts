import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "./rate-limit.guard";
import { RateLimitService, effectiveRateLimit } from "./rate-limit.service";
import { RATE_LIMIT_TIER } from "./use-rate-limit.decorator";

function makeContext(overrides: { userId?: string; ip?: string } = {}): ExecutionContext {
  const req = {
    user: overrides.userId !== undefined ? { userId: overrides.userId } : undefined,
    ip: overrides.ip ?? "10.0.0.1",
    headers: {},
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
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
    );
  });

  it("returns true when no tier metadata is set", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext({ userId: "user1" });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(rateLimitService.check).not.toHaveBeenCalled();
  });

  it("returns true when under the limit (authenticated user keyed by userId)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:chat");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const ctx = makeContext({ userId: "user-abc" });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(rateLimitService.check).toHaveBeenCalledWith("ai:chat", "user-abc");
  });

  it("throws 429 when over the limit (authenticated user)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:invoke");
    rateLimitService.check.mockResolvedValue({ allowed: false, retryAfterSecs: 30 });
    const ctx = makeContext({ userId: "user-xyz" });
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    let thrownStatus: number | undefined;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      if (e instanceof HttpException) thrownStatus = e.getStatus();
    }
    expect(thrownStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it("keys by client IP when no authenticated user (public route)", async () => {
    reflector.getAllAndOverride.mockReturnValue("ai:public-kb-ask");
    rateLimitService.check.mockResolvedValue({ allowed: true, retryAfterSecs: 0 });
    const ctx = makeContext({ ip: "203.0.113.5" });
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
    const ctx = makeContext({ userId: "u1" });
    await guard.canActivate(ctx);
    expect(rateLimitService.check).toHaveBeenCalledWith(setMetaTier, "u1");
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
