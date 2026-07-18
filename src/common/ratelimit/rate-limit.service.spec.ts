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

  it("allows any identifier for an unknown tier", async () => {
    const instance = svc();
    expect((await instance.check("unknown-tier", "x")).allowed).toBe(true);
  });
});
