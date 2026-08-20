import { Test } from "@nestjs/testing";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC } from "../../common/auth/public.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { RATE_LIMIT_TIER } from "../../common/ratelimit/use-rate-limit.decorator";
import { PublicController } from "./public.controller";
import { DRIZZLE } from "../../db/drizzle.constants";
import { platformWaitlistSignups } from "../../db/schema";
import { waitlistJoinSchema } from "./dto/public.schemas";
import { WaitlistService } from "./waitlist.service";
import type { RateLimitService as RateLimitServiceType } from "../../common/ratelimit/rate-limit.service";

describe("waitlistJoinSchema", () => {
  const valid = { name: "Aditya Sharma", email: "aditya@acme.com" };

  it("accepts the minimal required payload", () => {
    expect(waitlistJoinSchema.safeParse(valid).success).toBe(true);
  });

  it("normalizes the email to trimmed lowercase and trims the name", () => {
    const parsed = waitlistJoinSchema.parse({
      name: "  Aditya Sharma  ",
      email: "  Aditya@ACME.com  ",
      company: "  Acme Inc.  ",
    });
    expect(parsed.email).toBe("aditya@acme.com");
    expect(parsed.name).toBe("Aditya Sharma");
    expect(parsed.company).toBe("Acme Inc.");
  });

  it("rejects a missing name", () => {
    expect(waitlistJoinSchema.safeParse({ email: valid.email }).success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(waitlistJoinSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(waitlistJoinSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects oversized input", () => {
    expect(waitlistJoinSchema.safeParse({ ...valid, name: "a".repeat(121) }).success).toBe(false);
    expect(
      waitlistJoinSchema.safeParse({ ...valid, email: `${"a".repeat(320)}@acme.com` }).success,
    ).toBe(false);
    expect(waitlistJoinSchema.safeParse({ ...valid, company: "a".repeat(201) }).success).toBe(false);
  });

  it("rejects an unknown team size and an unknown source", () => {
    expect(waitlistJoinSchema.safeParse({ ...valid, teamSize: "10000+" }).success).toBe(false);
    expect(waitlistJoinSchema.safeParse({ ...valid, source: "spam" }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(waitlistJoinSchema.safeParse({ ...valid, isAdmin: true }).success).toBe(false);
  });
});

describe("WaitlistService", () => {
  const onConflictDoNothing = jest.fn();
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });
  const db = { insert };

  let svc: WaitlistService;

  beforeEach(async () => {
    jest.clearAllMocks();
    values.mockReturnValue({ onConflictDoNothing });
    insert.mockReturnValue({ values });
    onConflictDoNothing.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [WaitlistService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    svc = moduleRef.get(WaitlistService);
  });

  it("persists a normalized signup with request metadata", async () => {
    await expect(
      svc.join(
        {
          name: "  Aditya Sharma ",
          email: "  Aditya@ACME.com ",
          company: " Acme Inc. ",
          teamSize: "11-50",
        },
        { ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0" },
      ),
    ).resolves.toEqual({ ok: true });

    expect(insert).toHaveBeenCalledWith(platformWaitlistSignups);
    expect(values).toHaveBeenCalledWith({
      email: "aditya@acme.com",
      name: "Aditya Sharma",
      company: "Acme Inc.",
      teamSize: "11-50",
      source: "landing",
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });
  });

  it("stores null for an omitted or blank company and team size", async () => {
    await svc.join({ name: "Aditya", email: "aditya@acme.com", company: "   " }, {});

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ company: null, teamSize: null, ipAddress: null, userAgent: null }),
    );
  });

  it("truncates an oversized user agent", async () => {
    await svc.join(
      { name: "Aditya", email: "aditya@acme.com" },
      { userAgent: "u".repeat(900) },
    );

    const [row] = values.mock.calls[0] as [{ userAgent: string }];
    expect(row.userAgent).toHaveLength(500);
  });

  it("keeps a duplicate email idempotent and never surfaces the conflict", async () => {
    await svc.join({ name: "Aditya", email: "aditya@acme.com" }, {});
    onConflictDoNothing.mockResolvedValue([]);

    await expect(
      svc.join({ name: "Someone Else", email: "ADITYA@acme.com" }, {}),
    ).resolves.toEqual({ ok: true });

    expect(onConflictDoNothing).toHaveBeenCalledTimes(2);
    expect(onConflictDoNothing).toHaveBeenLastCalledWith({
      target: platformWaitlistSignups.email,
    });
  });
});

describe("public:waitlist rate-limit tier", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let RateLimitService: typeof RateLimitServiceType;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    jest.resetModules();
    ({ RateLimitService } = await import("../../common/ratelimit/rate-limit.service"));
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("allows 5 signups per identifier then blocks", async () => {
    const instance = new RateLimitService(null);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++)
      results.push((await instance.check("public:waitlist", "203.0.113.7")).allowed);

    expect(results.slice(0, 5).every((allowed) => allowed === true)).toBe(true);
    expect(results[5]).toBe(false);
  });

  it("isolates rate-limit buckets per client identifier", async () => {
    const instance = new RateLimitService(null);
    for (let i = 0; i < 6; i++) await instance.check("public:waitlist", "203.0.113.7");

    expect((await instance.check("public:waitlist", "198.51.100.4")).allowed).toBe(true);
  });
});

describe("POST /public/waitlist route metadata", () => {
  const handler = PublicController.prototype.joinWaitlist;

  it("is unauthenticated via the controller-level @Public() marker", () => {
    expect(Reflect.getMetadata(IS_PUBLIC, PublicController)).toBe(true);
  });

  it("is rate limited by the public:waitlist tier", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_TIER, handler)).toBe("public:waitlist");
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RateLimitGuard);
  });

  it("answers 201 on success", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(201);
  });
});
