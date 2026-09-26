import "reflect-metadata";
import { ExecutionContext, HttpException, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { effectiveRateLimit } from "../../common/ratelimit/rate-limit.service";
import { PublicController } from "./public.controller";

const EXPECTED: Array<{ method: keyof typeof PublicController.prototype; tier: string }> = [
  { method: "applicationStatus", tier: "public:application-status" },
  { method: "getOffer", tier: "public:offer" },
  { method: "respondToOffer", tier: "public:offer-respond" },
  { method: "getExternalReferrerPortal", tier: "public:referrer-portal" },
  { method: "submitExternalReferral", tier: "public:referral-submit" },
  { method: "getVendorPortal", tier: "public:vendor-portal" },
  { method: "listOrgJobs", tier: "public:careers-list" },
  { method: "getOrgJob", tier: "public:careers-job" },
  { method: "applyToOrgJob", tier: "public:job-apply" },
  { method: "getBookingLink", tier: "public:interview-booking" },
  { method: "registerExternalReferrer", tier: "public:referrer-register" },
  { method: "submitIntake", tier: "public:intake" },
  { method: "getPublicForm", tier: "public:form-view" },
  { method: "submitPublicForm", tier: "public:form-submit" },
  { method: "getLeadForm", tier: "public:lead-form-view" },
  { method: "submitLeadForm", tier: "public:lead-form-submit" },
  { method: "getSurvey", tier: "public:nps-view" },
  { method: "submitSurvey", tier: "public:nps-submit" },
  { method: "submitArticleFeedback", tier: "public:kb-feedback" },
  { method: "getOrgName", tier: "public:org-info" },
  { method: "getRoadmap", tier: "public:roadmap" },
  { method: "voteRoadmap", tier: "public:roadmap-vote" },
  { method: "submitRoadmapFeedback", tier: "public:roadmap-feedback" },
];

describe("public endpoint rate-limit wiring", () => {
  for (const { method, tier } of EXPECTED) {
    describe(method, () => {
      const handler = PublicController.prototype[method] as object;

      it(`carries @UseRateLimit("${tier}") and the tier has a registered TIERS entry`, () => {
        expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe(tier);
        expect(effectiveRateLimit(tier)).toBeGreaterThan(0);
      });

      it("has RateLimitGuard in its guard list", () => {
        const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        expect(guards).toContain(RateLimitGuard);
      });
    });
  }
});

type RateLimitServiceType = import("../../common/ratelimit/rate-limit.service").RateLimitService;

describe("public write routes — N+1 returns 429 with retry metadata", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let RateLimitServiceClass: new (redis: null) => RateLimitServiceType;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    jest.resetModules();
    const mod = await import("../../common/ratelimit/rate-limit.service");
    RateLimitServiceClass = mod.RateLimitService as unknown as new (redis: null) => RateLimitServiceType;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.resetModules();
  });

  function makeContext(tier: string, ip: string): ExecutionContext {
    const req = { user: undefined, ip, headers: {} };
    const res = { setHeader: jest.fn() };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  }

  it("public:job-apply blocks the 4th request from the same IP within an hour", async () => {
    const svc = new RateLimitServiceClass(null);
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue("public:job-apply") } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector, svc);
    const ctx = makeContext("public:job-apply", "10.0.0.1");

    for (let i = 0; i < 3; i++) await expect(guard.canActivate(ctx)).resolves.toBe(true);

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

    let thrownStatus: number | undefined;
    let thrownBody: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      if (e instanceof HttpException) {
        thrownStatus = e.getStatus();
        thrownBody = e.getResponse();
      }
    }
    expect(thrownStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((thrownBody as { retryAfterSecs: number }).retryAfterSecs).toBeGreaterThan(0);
  });

  it("public:nps-submit blocks the 6th request from the same IP within an hour", async () => {
    const svc = new RateLimitServiceClass(null);
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue("public:nps-submit") } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector, svc);
    const ctx = makeContext("public:nps-submit", "10.0.0.2");

    for (let i = 0; i < 5; i++) await expect(guard.canActivate(ctx)).resolves.toBe(true);

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

    let thrownStatus: number | undefined;
    let thrownBody: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      if (e instanceof HttpException) {
        thrownStatus = e.getStatus();
        thrownBody = e.getResponse();
      }
    }
    expect(thrownStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((thrownBody as { retryAfterSecs: number }).retryAfterSecs).toBeGreaterThan(0);
  });

  it("Retry-After response header is set on the 429", async () => {
    const svc = new RateLimitServiceClass(null);
    const req = { user: undefined, ip: "10.0.0.3", headers: {} };
    const res = { setHeader: jest.fn() };
    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue("public:kb-feedback") } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector, svc);

    for (let i = 0; i < 10; i++) await guard.canActivate(ctx);

    try {
      await guard.canActivate(ctx);
    } catch {
      // expected 429
    }
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("different IPs are rate-limited independently", async () => {
    const svc = new RateLimitServiceClass(null);
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue("public:job-apply") } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector, svc);

    const ipA = "10.1.0.1";
    const ipB = "10.1.0.2";

    const makeCtxForIp = (ip: string) => {
      const req = { user: undefined, ip, headers: {} };
      const res = { setHeader: jest.fn() };
      return {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ExecutionContext;
    };

    for (let i = 0; i < 3; i++) await guard.canActivate(makeCtxForIp(ipA));

    await expect(guard.canActivate(makeCtxForIp(ipA))).rejects.toThrow(HttpException);
    await expect(guard.canActivate(makeCtxForIp(ipB))).resolves.toBe(true);
  });
});

describe("new public write tier key registrations", () => {
  it.each([
    "public:job-apply",
    "public:referrer-register",
    "public:intake",
    "public:form-submit",
    "public:lead-form-submit",
    "public:nps-submit",
    "public:kb-feedback",
    "public:org-info",
    "public:careers-list",
    "public:careers-job",
    "public:interview-booking",
    "public:nps-view",
    "public:form-view",
    "public:lead-form-view",
    "blog:public-read",
  ])("tier %s resolves to a positive limit (deny-closed guard cannot hide a typo)", (tier) => {
    expect(effectiveRateLimit(tier)).toBeGreaterThan(0);
  });
});
