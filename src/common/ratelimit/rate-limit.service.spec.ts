import type { RateLimitService as RateLimitServiceType } from "./rate-limit.service";

describe("RateLimitService (in-memory fallback, no redis)", () => {
  // Non-production runs apply a 10x DEV_LIMIT_MULTIPLIER, resolved once at module load —
  // force NODE_ENV=production for a fresh module instance so limits match the raw tier config.
  const originalNodeEnv = process.env.NODE_ENV;
  let RateLimitService: typeof RateLimitServiceType;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    jest.resetModules();
    ({ RateLimitService } = await import("./rate-limit.service"));
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  const svc = () => new RateLimitService(null);

  it("allows up to the limit then blocks within the window", async () => {
    const instance = svc();
    const id = "k1";
    const results: boolean[] = [];
    for (let i = 0; i < 62; i++) results.push((await instance.check("api-key-ingest", id)).allowed);
    expect(results.slice(0, 60).every((r) => r === true)).toBe(true);
    expect(results[60]).toBe(false);
  });

  it("isolates different identifiers", async () => {
    const instance = svc();
    expect((await instance.check("api-key-ingest", "a")).allowed).toBe(true);
    expect((await instance.check("api-key-ingest", "b")).allowed).toBe(true);
  });

  it("limits attendance report delivery requests to five per hour", async () => {
    const instance = svc();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        instance.check("hr:attendance-report", "manager-1"),
      ),
    );
    expect(results.slice(0, 5).every((result) => result.allowed)).toBe(true);
    expect(results[5]?.allowed).toBe(false);
  });

  it.each([
    ["hr:employee-backfill", 3],
    ["hr:employee-bulk-onboard", 10],
    ["hr:effective-changes-apply", 10],
    ["hr:onboarding-reminders", 3],
  ])("enforces the %s command tier", async (tier, limit) => {
    const instance = svc();
    const results = await Promise.all(
      Array.from({ length: limit + 1 }, () => instance.check(tier, "admin-1")),
    );

    expect(results.slice(0, limit).every((result) => result.allowed)).toBe(true);
    expect(results[limit]?.allowed).toBe(false);
  });

  it("per-email OTP request limit allows five requests then blocks — a single account cannot exhaust the budget from many IPs", async () => {
    const instance = svc();
    const email = "alice@corp.example";
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push((await instance.check("auth:email-otp:email", email)).allowed);
    expect(results.slice(0, 5).every((r) => r === true)).toBe(true);
    expect(results[5]).toBe(false);
  });

  it("colleagues behind one office IP do not consume each other's per-email OTP request budget", async () => {
    const instance = svc();
    const sharedIp = "203.0.113.1";
    const emails = ["alice@corp.example", "bob@corp.example", "carol@corp.example", "dave@corp.example", "eve@corp.example"];
    for (const email of emails) {
      await instance.check("auth:email-otp", sharedIp);
      const emailResult = await instance.check("auth:email-otp:email", email);
      expect([email, emailResult.allowed]).toEqual([email, true]);
    }
  });

  it("per-IP OTP request ceiling allows up to twenty requests before blocking — a shared office NAT is not locked out by the fourth colleague", async () => {
    const instance = svc();
    const officeIp = "203.0.113.1";
    const results: boolean[] = [];
    for (let i = 0; i < 20; i++) results.push((await instance.check("auth:email-otp", officeIp)).allowed);
    expect(results.every((r) => r === true)).toBe(true);
    expect((await instance.check("auth:email-otp", officeIp)).allowed).toBe(false);
  });

  it("per-email OTP verify limit allows ten requests then blocks — per-account verify budget is independent of IP", async () => {
    const instance = svc();
    const email = "verify@corp.example";
    const results: boolean[] = [];
    for (let i = 0; i < 11; i++) results.push((await instance.check("auth:email-otp-verify:email", email)).allowed);
    expect(results.slice(0, 10).every((r) => r === true)).toBe(true);
    expect(results[10]).toBe(false);
  });

  it("per-IP OTP verify ceiling allows up to forty requests before blocking — office colleagues share headroom without locking each other out", async () => {
    const instance = svc();
    const officeIp = "203.0.113.1";
    const results: boolean[] = [];
    for (let i = 0; i < 40; i++) results.push((await instance.check("auth:email-otp-verify", officeIp)).allowed);
    expect(results.every((r) => r === true)).toBe(true);
    expect((await instance.check("auth:email-otp-verify", officeIp)).allowed).toBe(false);
  });

  it("different email addresses have independent per-email OTP verify budgets", async () => {
    const instance = svc();
    const emails = ["alice@corp.example", "bob@corp.example"];
    for (const email of emails) {
      const result = await instance.check("auth:email-otp-verify:email", email);
      expect([email, result.allowed]).toEqual([email, true]);
    }
  });

  // SEC-004: an unregistered tier must fail closed rather than bypassing limits.
  it("denies an unknown tier rather than failing open", async () => {
    const instance = svc();
    const result = await instance.check("unknown-tier", "x");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSecs).toBeGreaterThan(0);
  });

  describe("the fallback map is bounded without Redis", () => {
    it("drops windows that have lapsed rather than waiting to be asked again", async () => {
      jest.useFakeTimers();
      try {
        const instance = svc();
        for (let i = 0; i < 200; i++)
          await instance.check("api-key-ingest", `probe-ip-${String(i)}`);
        expect(instance.memoryKeyCount()).toBe(200);

        jest.advanceTimersByTime(10 * 60 * 1000);
        await instance.check("api-key-ingest", "one-more");

        expect(instance.memoryKeyCount()).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("still enforces the limit for an identifier inside its window", async () => {
      const instance = svc();
      const results: boolean[] = [];
      for (let i = 0; i < 62; i++)
        results.push((await instance.check("api-key-ingest", "steady")).allowed);

      expect(results.slice(0, 60).every((allowed) => allowed === true)).toBe(true);
      expect(results[60]).toBe(false);
    });
  });
});
